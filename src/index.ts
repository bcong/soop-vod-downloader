import axios, { AxiosInstance } from "axios";
import * as readline from "readline";
import { spawn, execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

// ─────────────────────────────────────────────
//  타입 정의
// ─────────────────────────────────────────────

interface VodItem {
    index: number; // 1-based 순번 (1 = 최신)
    titleNo: number; // VOD 고유 ID
    title: string;
    date: string;
    duration: string;
    fileSize: number; // bytes (0 = 알 수 없음)
    viewCount: number;
    url: string;
}

// ─────────────────────────────────────────────
//  유틸리티
// ─────────────────────────────────────────────

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatFileSize(bytes: number): string {
    if (bytes <= 0) return "-";
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
    return `${(bytes / 1024).toFixed(0)}KB`;
}

function sanitizeFilename(name: string, maxLen = 80): string {
    return name
        .replace(/[\\/:*?"<>|]/g, "_")
        .replace(/\s+/g, " ")
        .trim()
        .substring(0, maxLen);
}

function formatDuration(seconds: number | string): string {
    const s = parseInt(String(seconds), 10);
    if (isNaN(s) || s <= 0) return "";
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    return `${m}:${String(sec).padStart(2, "0")}`;
}

// ─────────────────────────────────────────────
//  SOOP API 타입
// ─────────────────────────────────────────────

interface VodApiItem {
    title_no: number;
    title_name: string;
    user_id: string;
    reg_date: string;
    ucc?: { total_file_duration?: number; total_file_size?: number };
    count?: { read_cnt?: number };
}

interface VodApiResponse {
    data: VodApiItem[];
    meta: {
        current_page: number;
        last_page: number;
        total: number;
        per_page: number;
    };
}

// ─────────────────────────────────────────────
//  SOOP VOD 다운로더
// ─────────────────────────────────────────────

interface Settings {
    speedLimitMB: number | null;
    concurrency: number; // 1 = 순차, 2이상 = 병렬
    lastUserId: string;
    lastOutputDir: string;
    lastFrom: number;
    lastTo: number | null;
}

const CONFIG_PATH = path.join(process.cwd(), "config.json");

function loadConfig(): Settings {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const raw = fs.readFileSync(CONFIG_PATH, "utf8");
            const parsed = JSON.parse(raw) as Partial<Settings>;
            return {
                speedLimitMB: parsed.speedLimitMB ?? null,
                concurrency: parsed.concurrency ?? 1,
                lastUserId: parsed.lastUserId ?? "",
                lastOutputDir: parsed.lastOutputDir ?? "",
                lastFrom: parsed.lastFrom ?? 1,
                lastTo: parsed.lastTo ?? null,
            };
        }
    } catch {
        // 파일 손상 시 기본값 사용
    }
    return { speedLimitMB: null, concurrency: 1, lastUserId: "", lastOutputDir: "", lastFrom: 1, lastTo: null };
}

function saveConfig(settings: Settings): void {
    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(settings, null, 2), "utf8");
    } catch {
        // 저장 실패는 무시
    }
}

class SoopVodDownloader {
    private rl: readline.Interface;
    private http: AxiosInstance;
    private settings: Settings;

    constructor() {
        this.settings = loadConfig();

        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });

        this.http = axios.create({
            timeout: 30_000,
            headers: {
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
                    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                Accept: "application/json, text/html, */*;q=0.8",
                "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8",
                Referer: "https://www.sooplive.com/",
            },
        });
    }

    // ── 입력 헬퍼 ─────────────────────────────

    private ask(prompt: string): Promise<string> {
        return new Promise((resolve) => {
            this.rl.question(prompt, (ans) => resolve(ans.trim()));
        });
    }

    private async askInt(prompt: string, min: number, max: number): Promise<number> {
        while (true) {
            const raw = await this.ask(prompt);
            const n = parseInt(raw, 10);
            if (!isNaN(n) && n >= min && n <= max) return n;
            console.log(`  ⚠  ${min} ~ ${max} 사이의 숫자를 입력해주세요.`);
        }
    }

    // ── VOD 목록 수집 ────────────────────────

    async fetchAllVods(userId: string): Promise<VodItem[]> {
        const allVods: Omit<VodItem, "index">[] = [];
        let page = 1;
        let lastPage = 1;

        console.log(`\n'${userId}' 스트리머의 VOD 목록 수집 중...\n`);

        do {
            process.stdout.write(`\r  페이지 ${page}/${lastPage} 검색 중...          `);

            const apiUrl = `https://chapi.sooplive.com/api/${userId}/vods/all/streamer`;

            let resp: { data: VodApiResponse };
            try {
                resp = await this.http.get(apiUrl, {
                    params: {
                        keyword: "",
                        orderby: "reg_date",
                        page,
                        per_page: 20,
                        start_date: "",
                        end_date: "",
                    },
                    headers: { Accept: "application/json" },
                });
            } catch (err: unknown) {
                const status = (err as { response?: { status?: number } }).response?.status;
                if (status === 404) {
                    if (page === 1) {
                        process.stdout.write("\n");
                        console.log(`  스트리머 '${userId}'를 찾을 수 없습니다. 아이디를 확인해주세요.`);
                        return [];
                    }
                    break;
                }
                process.stdout.write("\n");
                console.error(`  페이지 ${page} 요청 실패:`, (err as Error).message);
                break;
            }

            const json = resp.data;
            lastPage = json.meta.last_page;

            for (const item of json.data) {
                const durationMs = item.ucc?.total_file_duration ?? 0;
                allVods.push({
                    titleNo: item.title_no,
                    title: item.title_name,
                    date: item.reg_date.substring(0, 10),
                    duration: formatDuration(Math.floor(durationMs / 1000)),
                    fileSize: item.ucc?.total_file_size ?? 0,
                    viewCount: item.count?.read_cnt ?? 0,
                    url: `https://vod.sooplive.co.kr/player/${item.title_no}`,
                });
            }

            page++;
            if (page <= lastPage) await delay(200);
        } while (page <= lastPage);

        process.stdout.write("\r  검색 완료.                          \n");

        // index 할당 (1 = 최신)
        return allVods.map((v, i) => ({ ...v, index: i + 1 }));
    }

    // ── 다운로드 ──────────────────────────────

    /** 로컬 ffmpeg.exe 우선, 없으면 PATH 에서 탐색 */
    private resolveFfmpegPath(): string | null {
        const candidates = [
            path.join(process.cwd(), "ffmpeg.exe"),
            path.join(process.cwd(), "ffmpeg"),
            path.join(__dirname, "..", "ffmpeg.exe"),
            path.join(__dirname, "..", "ffmpeg"),
        ];
        for (const p of candidates) {
            if (fs.existsSync(p)) return p;
        }
        return null; // PATH 에 있으면 yt-dlp가 알아서 찾음
    }

    /** 로컬 yt-dlp.exe 우선, 없으면 PATH 에서 탐색 */
    private resolveYtDlpPath(): string {
        const candidates = [
            path.join(process.cwd(), "yt-dlp.exe"),
            path.join(process.cwd(), "yt-dlp"),
            path.join(__dirname, "..", "yt-dlp.exe"),
            path.join(__dirname, "..", "yt-dlp"),
        ];
        for (const p of candidates) {
            if (fs.existsSync(p)) return p;
        }
        return "yt-dlp"; // PATH 에서 탐색
    }

    private checkYtDlp(): boolean {
        try {
            execSync(`"${this.resolveYtDlpPath()}" --version`, { stdio: "pipe" });
            return true;
        } catch {
            return false;
        }
    }

    /** 지정 경로 드라이브의 여유 공간(GB)을 반환. 확인 불가 시 Infinity */
    private getAvailableDiskSpaceGB(dir: string): number {
        try {
            // Node.js 18.15+ 에서 제공하는 fs.statfsSync 사용
            const stats = (
                fs as unknown as { statfsSync: (p: string) => { bsize: number; bavail: number } }
            ).statfsSync(dir);
            return (stats.bavail * stats.bsize) / (1024 * 1024 * 1024);
        } catch {
            return Infinity;
        }
    }

    private openFolderDialog(defaultPath: string): string | null {
        try {
            const ps = [
                `Add-Type -AssemblyName System.Windows.Forms;`,
                `$d = New-Object System.Windows.Forms.FolderBrowserDialog;`,
                `$d.Description = '저장 폴더를 선택하세요';`,
                `$d.ShowNewFolderButton = $true;`,
                `$d.SelectedPath = '${defaultPath.replace(/'/g, "''")}';`,
                `$r = $d.ShowDialog();`,
                `if ($r -eq 'OK') { $d.SelectedPath } else { '' }`,
            ].join(" ");
            const result = execSync(`powershell -NoProfile -Command "${ps}"`, {
                stdio: ["pipe", "pipe", "pipe"],
                encoding: "utf8",
            }).trim();
            return result || null;
        } catch {
            console.log(`  ⚠  폴더 선택창을 열 수 없습니다. 직접 경로를 입력해주세요.`);
            return null;
        }
    }

    /** SOOP API에서 VOD의 실제 파일 URL 목록을 가져옴 (멀티파트 지원) */
    private async getVodFileUrls(titleNo: number, vodUrl: string): Promise<string[]> {
        try {
            const resp = await this.http.post(
                "https://api.m.sooplive.co.kr/station/video/a/view",
                `nTitleNo=${titleNo}&nApiLevel=10`,
                {
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded",
                        Referer: vodUrl,
                    },
                },
            );
            const files = resp.data?.data?.files;
            if (Array.isArray(files) && files.length > 0) {
                return (files as { file?: string }[]).map((f) => f.file ?? "").filter(Boolean);
            }
        } catch {
            // API 실패 시 빈 배열 → 기본 방식으로 폴백
        }
        return [];
    }

    /** yt-dlp 단일 실행 — args 에 URL/출력 경로 포함 */
    private runYtDlp(args: string[], onProgress?: (line: string) => void): Promise<void> {
        return new Promise((resolve, reject) => {
            const ytDlpPath = this.resolveYtDlpPath();
            const proc = spawn(ytDlpPath, args, { stdio: ["ignore", "pipe", "pipe"] });

            proc.stdout.on("data", (chunk: Buffer) => {
                for (const rawLine of chunk.toString().split(/\r?\n/)) {
                    const line = rawLine.trim();
                    if (line.startsWith("[download]") && line.includes("%")) {
                        if (onProgress) onProgress(line);
                        else process.stdout.write(`\r    ${line.substring(0, 72).padEnd(72)}`);
                    }
                }
            });

            proc.stderr.on("data", (chunk: Buffer) => {
                const txt = chunk.toString().trim();
                if (txt && !txt.startsWith("WARNING") && !txt.startsWith("[debug]")) {
                    if (!onProgress) process.stderr.write(`\n    [경고] ${txt}\n`);
                }
            });

            proc.on("close", (code) => {
                if (!onProgress) process.stdout.write("\n");
                // exit code 가 0 이 아니어도 파일이 생성됐으면 호출자가 판단
                if (code === 0) resolve();
                else reject(new Error(`yt-dlp 종료 코드 ${code}`));
            });

            proc.on("error", (err) => reject(new Error(`프로세스 실행 실패: ${err.message}`)));
        });
    }

    /** ffmpeg concat demuxer 로 파트 파일들을 하나로 합침 */
    private concatVideoParts(inputFiles: string[], outputFile: string, ffmpegPath: string | null): Promise<void> {
        return new Promise((resolve, reject) => {
            const ffmpegCmd = ffmpegPath ?? "ffmpeg";
            // 모든 파일이 같은 디렉터리에 있다고 가정
            // 입·출력 모두 파일명(상대경로)만 사용 → 한글·특수문자 절대경로 파싱 오류 방지
            const cwd = path.dirname(inputFiles[0]);
            const outBasename = path.basename(outputFile);
            const listFile = path.join(cwd, "_concat_list.txt");
            const listContent = inputFiles.map((f) => `file '${path.basename(f)}'\n`).join("");
            fs.writeFileSync(listFile, listContent, "utf8");

            const proc = spawn(
                ffmpegCmd,
                ["-f", "concat", "-safe", "0", "-i", "_concat_list.txt", "-c", "copy", "-y", outBasename],
                { stdio: ["ignore", "pipe", "pipe"], cwd },
            );

            proc.on("close", (code) => {
                try {
                    fs.rmSync(listFile);
                } catch {
                    /* 무시 */
                }
                if (code === 0) resolve();
                else reject(new Error(`ffmpeg concat 실패 (종료 코드 ${code})`));
            });
            proc.on("error", (err) => {
                try {
                    fs.rmSync(listFile);
                } catch {
                    /* 무시 */
                }
                reject(new Error(`ffmpeg 실행 실패: ${err.message}`));
            });
        });
    }

    private async downloadOne(
        vod: VodItem,
        outputDir: string,
        speedLimitMB: number | null = null,
        onProgress?: (line: string) => void,
    ): Promise<void> {
        const safeName = sanitizeFilename(vod.title);
        const tempDir = path.join(outputDir, "_temp");
        fs.mkdirSync(tempDir, { recursive: true });
        const tempBase = `[${vod.index}] ${safeName}`;
        const finalFile = path.join(outputDir, `${safeName}.mp4`);

        const ffmpegPath = this.resolveFfmpegPath();

        // 같은 인덱스 잔여 임시 파일 정리 (이전 실패 다운로드 잔여물 포함)
        const cleanupTempFiles = (): void => {
            try {
                const prefix = `[${vod.index}]`;
                for (const f of fs.readdirSync(tempDir)) {
                    if (f.startsWith(prefix)) {
                        try {
                            fs.rmSync(path.join(tempDir, f));
                        } catch {
                            /* 무시 */
                        }
                    }
                }
                // concat 리스트 파일도 정리
                const listFile = path.join(tempDir, "_concat_list.txt");
                if (fs.existsSync(listFile)) {
                    try {
                        fs.rmSync(listFile);
                    } catch {
                        /* 무시 */
                    }
                }
            } catch {
                /* 무시 */
            }
        };

        // ① 최종 파일이 이미 존재하면 잔여 임시파일 정리 후 건너뜀
        if (fs.existsSync(finalFile) && fs.statSync(finalFile).size > 0) {
            cleanupTempFiles();
            if (onProgress) onProgress("__skipped__");
            else process.stdout.write(`    건너뜀 (이미 존재): ${safeName}\n`);
            return;
        }

        // 이전 실패 다운로드의 잔여 임시파일 선제 정리
        cleanupTempFiles();

        // ② SOOP API 에서 실제 m3u8 파일 URL 목록 조회
        const fileUrls = await this.getVodFileUrls(vod.titleNo, vod.url);

        if (fileUrls.length === 0) {
            // API 실패 폴백: vod.url + --concat-playlist always (multi_video 처리)
            const outTemplate = path.join(tempDir, `${tempBase}.%(ext)s`);
            const tempFile = path.join(tempDir, `${tempBase}.mp4`);
            const args = [
                vod.url,
                "-o",
                outTemplate,
                "--progress",
                "--no-warnings",
                "--newline",
                "--merge-output-format",
                "mp4",
                "--concat-playlist",
                "always",
                "--concurrent-fragments",
                "8",
                ...(speedLimitMB !== null ? ["--limit-rate", `${speedLimitMB}M`] : []),
                ...(ffmpegPath ? ["--ffmpeg-location", ffmpegPath] : []),
            ];
            try {
                await this.runYtDlp(args, onProgress);
            } catch {
                /* 파일 있으면 계속 */
            }
            if (fs.existsSync(tempFile) && fs.statSync(tempFile).size > 0) {
                fs.renameSync(tempFile, finalFile);
                cleanupTempFiles();
            }
            return;
        }

        // ③ m3u8 URL 로 파트별 다운로드 → ffmpeg concat (파트 파일은 _temp 안에서만 존재)
        const partFiles: string[] = [];
        for (let i = 0; i < fileUrls.length; i++) {
            const partBase = `${tempBase}_p${String(i + 1).padStart(2, "0")}`;
            const partTemplate = path.join(tempDir, `${partBase}.%(ext)s`);
            const partFile = path.join(tempDir, `${partBase}.mp4`);

            if (fileUrls.length > 1) {
                if (onProgress) onProgress(`__status__파트 ${i + 1}/${fileUrls.length}`);
                else process.stdout.write(`\n    ▶ 파트 ${i + 1}/${fileUrls.length} 다운로드 중...\n`);
            }

            const partArgs = [
                fileUrls[i],
                "-o",
                partTemplate,
                "--no-playlist",
                "--progress",
                "--no-warnings",
                "--newline",
                "--merge-output-format",
                "mp4",
                "--concurrent-fragments",
                "8",
                ...(speedLimitMB !== null ? ["--limit-rate", `${speedLimitMB}M`] : []),
                ...(ffmpegPath ? ["--ffmpeg-location", ffmpegPath] : []),
            ];

            try {
                await this.runYtDlp(partArgs, onProgress);
            } catch {
                /* 파일 있으면 계속 */
            }

            if (fs.existsSync(partFile) && fs.statSync(partFile).size > 0) {
                partFiles.push(partFile);
            } else {
                // 파일명이 다를 수 있으니 스캔
                const alts = fs
                    .readdirSync(tempDir)
                    .filter((f) => f.startsWith(partBase) && f.endsWith(".mp4"))
                    .map((f) => path.join(tempDir, f));
                if (alts.length > 0) {
                    fs.renameSync(alts[0], partFile);
                    partFiles.push(partFile);
                }
            }
        }

        if (partFiles.length === 0) throw new Error("다운로드된 파트 파일 없음");

        try {
            if (partFiles.length === 1) {
                fs.renameSync(partFiles[0], finalFile);
            } else {
                if (onProgress) onProgress(`__status__합치는 중...`);
                else process.stdout.write(`\n    ▶ ${partFiles.length}개 파트 합치는 중...\n`);
                const concatTemp = path.join(tempDir, `${tempBase}.mp4`);
                await this.concatVideoParts(partFiles, concatTemp, ffmpegPath);
                fs.renameSync(concatTemp, finalFile);
            }
        } finally {
            // 파트 파일 명시적 삭제 (prefix 방식보다 정확)
            for (const f of partFiles) {
                try {
                    if (fs.existsSync(f)) fs.unlinkSync(f);
                } catch {
                    /* 무시 */
                }
            }
            // concat 리스트 파일도 정리
            const listFile = path.join(tempDir, "_concat_list.txt");
            try {
                if (fs.existsSync(listFile)) fs.unlinkSync(listFile);
            } catch {
                /* 무시 */
            }
        }
    }

    // ── 목록 출력 ─────────────────────────────

    private printVodTable(vods: VodItem[], from: number, to: number): void {
        console.log();
        for (const vod of vods.slice(from - 1, to)) {
            const num = String(vod.index).padStart(4);
            const title = vod.title.length > 50 ? vod.title.substring(0, 49) + "…" : vod.title;
            const meta: string[] = [vod.date];
            if (vod.duration) meta.push(vod.duration);
            if (vod.fileSize > 0) meta.push(formatFileSize(vod.fileSize));
            console.log(`  ${num}.  ${title}`);
            console.log(`         ${meta.join("  ·  ")}`);
        }
        console.log();
    }

    // ── 메인 플로우 ───────────────────────────

    private async runDownloadFlow(): Promise<void> {
        const lastId = this.settings.lastUserId;
        const prompt = lastId ? `\n스트리머 아이디 입력 (엔터 = ${lastId}): ` : "\n스트리머 아이디 입력: ";
        const input = await this.ask(prompt);
        const userId = input || lastId;
        if (!userId) {
            console.log("아이디를 입력해주세요.");
            return;
        }
        if (userId !== this.settings.lastUserId) {
            this.settings.lastUserId = userId;
            saveConfig(this.settings);
        }

        // 1) 전체 VOD 목록 수집
        const vods = await this.fetchAllVods(userId);
        if (vods.length === 0) return;

        console.log(`\n총 ${vods.length}개의 VOD를 찾았습니다.`);
        console.log(`  1번 (최신)  : ${vods[0].title}  [${vods[0].date}]`);
        console.log(
            `  ${vods.length}번 (가장 오래됨): ${vods[vods.length - 1].title}  [${vods[vods.length - 1].date}]`,
        );

        // 2) VOD 목록 출력 후 범위 입력
        this.printVodTable(vods, 1, vods.length);
        const savedFrom = this.settings.lastFrom;
        const savedTo = this.settings.lastTo ?? vods.length;
        console.log(`\n다운로드할 번호 범위를 입력하세요 (1 = 최신, ${vods.length} = 가장 오래됨)`);
        let from: number;
        let to: number;

        while (true) {
            const rawFrom = await this.ask(`  시작 번호 (1 ~ ${vods.length}, 엔터 = ${savedFrom}): `);
            from = rawFrom ? parseInt(rawFrom, 10) : savedFrom;
            if (isNaN(from) || from < 1 || from > vods.length) {
                console.log(`  ⚠  1 ~ ${vods.length} 사이의 숫자를 입력해주세요.`);
                continue;
            }
            const rawTo = await this.ask(`  끝   번호 (1 ~ ${vods.length}, 엔터 = ${savedTo}): `);
            to = rawTo ? parseInt(rawTo, 10) : savedTo;
            if (isNaN(to) || to < 1 || to > vods.length) {
                console.log(`  ⚠  1 ~ ${vods.length} 사이의 숫자를 입력해주세요.`);
                continue;
            }
            if (from > to) {
                console.log("  ⚠  시작 번호가 끝 번호보다 큽니다. 다시 입력해주세요.");
                continue;
            }
            break;
        }

        if (from !== this.settings.lastFrom || to !== this.settings.lastTo) {
            this.settings.lastFrom = from;
            this.settings.lastTo = to;
            saveConfig(this.settings);
        }

        // 3) 다운로드 순서 선택
        const count = to - from + 1;
        console.log(`\n${from}번 ~ ${to}번, 총 ${count}개 다운로드 순서를 선택하세요:`);
        console.log(`  1. 최신 → 과거 순서로 다운로드 (${from}번부터)`);
        console.log(`  2. 과거 → 최신 순서로 다운로드 (${to}번부터)`);
        const orderChoice = await this.askInt(`선택 (1~2): `, 1, 2);

        // 4) yt-dlp 확인
        if (!this.checkYtDlp()) {
            console.log("\n⚠  yt-dlp가 설치되어 있지 않습니다.");
            console.log("   설치 방법:");
            console.log("     pip install yt-dlp");
            console.log("     또는");
            console.log("     winget install yt-dlp\n");
            return;
        }

        // 5) 출력 폴더 선택
        const defaultOutputDir = this.settings.lastOutputDir || path.join(process.cwd(), "downloads", userId);
        console.log(`\n기본 저장 경로: ${defaultOutputDir}`);
        console.log(`  1) 기본값 사용`);
        console.log(`  2) 폴더 찾아보기 창 열기`);
        console.log(`  3) 직접 경로 입력`);
        const pathChoice = await this.askInt(`선택 (1~3): `, 1, 3);

        let outputDir: string;
        if (pathChoice === 2) {
            const picked = this.openFolderDialog(defaultOutputDir);
            outputDir = picked ?? defaultOutputDir;
            if (!picked) console.log(`  (선택 취소됨 — 기본 경로 사용)`);
        } else if (pathChoice === 3) {
            const inputDir = await this.ask(`저장 경로 입력: `);
            outputDir = inputDir.trim() ? path.resolve(inputDir.trim()) : defaultOutputDir;
        } else {
            outputDir = defaultOutputDir;
        }

        if (outputDir !== this.settings.lastOutputDir) {
            this.settings.lastOutputDir = outputDir;
            saveConfig(this.settings);
        }

        fs.mkdirSync(outputDir, { recursive: true });
        console.log(`\n저장 경로: ${outputDir}`);
        console.log(`yt-dlp  : ${this.resolveYtDlpPath()}`);
        const ffmpegPath = this.resolveFfmpegPath();
        console.log(`ffmpeg  : ${ffmpegPath ?? "(PATH에서 자동 탐색)"}\n`);

        // 디스크 여유 공간 사전 확인 (1GB 미만이면 중단)
        const initialSpaceGB = this.getAvailableDiskSpaceGB(outputDir);
        if (initialSpaceGB < 1) {
            console.log(`⚠  저장 경로의 디스크 여유 공간이 ${initialSpaceGB.toFixed(2)}GB 밖에 없습니다.`);
            console.log(`   최소 1GB 이상의 여유 공간이 필요합니다. 다운로드를 시작하지 않습니다.\n`);
            return;
        }

        // 6) 다운로드 실행 (순차/병렬 통합 대시보드)
        const concurrency = this.settings.concurrency;
        const baseSelected = vods.slice(from - 1, to);
        const selected = orderChoice === 2 ? [...baseSelected].reverse() : baseSelected;
        let successCount = 0;
        let failCount = 0;
        let skipCount = 0;
        let diskFullStoppedVodNo: number | null = null;

        const totalSpeedMB = this.settings.speedLimitMB;
        // --concurrent-fragments 8 로 세그먼트를 병렬 다운로드하므로
        // --limit-rate 는 세그먼트 1개 기준으로 적용됨 → 총 목표 속도를 8로 나눠서 전달
        const CONCURRENT_FRAGMENTS = 8;
        const perSpeedMB =
            totalSpeedMB !== null ? Math.max(0.1, totalSpeedMB / concurrency / CONCURRENT_FRAGMENTS) : null;

        {
            const total = selected.length;
            let nextIdx = 0;

            // 슬롯별 현재 VOD 번호, 파트 라벨, 진행률+속도
            const slotNo: string[] = Array.from({ length: concurrency }, () => "-");
            const slotPart: string[] = Array.from({ length: concurrency }, () => "");
            const slotPct: string[] = Array.from({ length: concurrency }, () => "-");

            const parsePct = (line: string): string => {
                const mPct = line.match(/(\d+\.?\d*)%/);
                const mSpd = line.match(/at\s+([\d.]+\s*\S+\/s)/i);
                const pct = mPct ? `${parseFloat(mPct[1]).toFixed(1)}%` : "...";
                const spd = mSpd ? mSpd[1].trim() : null;
                return spd ? `${pct}  ${spd}` : pct;
            };

            const printLine = (): void => {
                const parts = Array.from({ length: concurrency }, (_, s) => {
                    const no = `#${slotNo[s]}`;
                    const part = slotPart[s] ? `  ${slotPart[s]}` : "";
                    const pct = `  ${slotPct[s]}`;
                    return `${no}${part}${pct}`;
                });
                process.stdout.write(`\r${parts.join("   |   ")}   `);
            };

            console.log();
            const renderInterval = setInterval(printLine, 200);

            const runSlot = async (slot: number): Promise<void> => {
                while (nextIdx < total) {
                    // 디스크 여유 공간 확인 (1GB 미만이면 중단)
                    const availGB = this.getAvailableDiskSpaceGB(outputDir);
                    if (availGB < 1) {
                        if (diskFullStoppedVodNo === null && nextIdx < total) {
                            diskFullStoppedVodNo = selected[nextIdx].index;
                        }
                        nextIdx = total; // 모든 슬롯 종료
                        return;
                    }
                    const idx = nextIdx++;
                    const vod = selected[idx];
                    slotNo[slot] = String(vod.index);
                    slotPart[slot] = "";
                    slotPct[slot] = "0%";
                    try {
                        let skipped = false;
                        await this.downloadOne(vod, outputDir, perSpeedMB, (progressLine) => {
                            if (progressLine === "__skipped__") {
                                skipped = true;
                                return;
                            }
                            if (progressLine.startsWith("__status__")) {
                                slotPart[slot] = progressLine.slice(10);
                                slotPct[slot] = "";
                                return;
                            }
                            slotPct[slot] = parsePct(progressLine);
                        });
                        if (skipped) {
                            slotPct[slot] = "건너뜀";
                            skipCount++;
                        } else {
                            slotPct[slot] = "완료";
                            successCount++;
                        }
                    } catch (err: unknown) {
                        slotPct[slot] = "실패";
                        failCount++;
                    }
                    slotNo[slot] = "-";
                    slotPart[slot] = "";
                    slotPct[slot] = "-";
                }
            };

            await Promise.all(Array.from({ length: concurrency }, (_, slot) => runSlot(slot)));
            clearInterval(renderInterval);
            printLine();
            console.log();
        }

        // 7) 결과 요약
        const sep = "═".repeat(44);
        console.log(sep);
        console.log(`다운로드 완료  성공: ${successCount}개  /  건너뜀: ${skipCount}개  /  실패: ${failCount}개`);
        if (diskFullStoppedVodNo !== null) {
            console.log(`⚠  디스크 용량 부족으로 ${diskFullStoppedVodNo}번 VOD에서 다운로드가 중단되었습니다.`);
        }
        console.log(`저장 위치: ${outputDir}`);
        console.log(sep + "\n");
    }

    // ── 설정 ──────────────────────────────────

    private async runSettingsFlow(): Promise<void> {
        while (true) {
            const speedLabel = this.settings.speedLimitMB !== null ? `${this.settings.speedLimitMB} MB/s` : `무제한`;
            const concLabel = this.settings.concurrency <= 1 ? `순차` : `병렬 ${this.settings.concurrency}개`;
            console.log(`\n[ 설 정 ]`);
            console.log(`  1. 다운로드 속도 제한  (현재: ${speedLabel})`);
            console.log(`  2. 다운로드 방식      (현재: ${concLabel})`);
            console.log(`  0. 뒤로`);

            const choice = await this.ask("\n선택 > ");

            if (choice === "0") {
                break;
            } else if (choice === "1") {
                console.log(`\n속도 제한 설정 (단위: MB/s)`);
                console.log(`  예) 50  → 50 MB/s 로 제한`);
                console.log(`  예) 0   → 무제한`);
                const raw = await this.ask(`속도 입력 (현재: ${speedLabel}): `);
                const val = parseFloat(raw);
                if (!isNaN(val) && val >= 0) {
                    this.settings.speedLimitMB = val === 0 ? null : val;
                    saveConfig(this.settings);
                    const label = this.settings.speedLimitMB !== null ? `${this.settings.speedLimitMB} MB/s` : `무제한`;
                    console.log(`  ✓ 속도 제한이 [${label}] 으로 설정되었습니다.\n`);
                } else {
                    console.log(`  ⚠  올바른 숫자를 입력해주세요.\n`);
                }
            } else if (choice === "2") {
                console.log(`\n다운로드 방식 설정`);
                console.log(`  예) 1  → 순차 (1개씩)`);
                console.log(`  예) 3  → 병렬 3개 동시`);
                const raw = await this.ask(`동시 수 입력 (현재: ${concLabel}): `);
                const val = parseInt(raw, 10);
                if (!isNaN(val) && val >= 1) {
                    this.settings.concurrency = val;
                    saveConfig(this.settings);
                    const label = val <= 1 ? `순차` : `병렬 ${val}개`;
                    console.log(`  ✓ 다운로드 방식이 [${label}] 으로 설정되었습니다.\n`);
                } else {
                    console.log(`  ⚠  1 이상의 숫자를 입력해주세요.\n`);
                }
            } else {
                console.log("올바른 번호를 입력해주세요.\n");
            }
        }
    }

    // ── 루프 진입점 ───────────────────────────

    async run(): Promise<void> {
        while (true) {
            const speedLabel = this.settings.speedLimitMB !== null ? `${this.settings.speedLimitMB} MB/s` : `무제한`;
            const concLabel = this.settings.concurrency <= 1 ? `순차` : `병렬 ${this.settings.concurrency}개`;
            console.log("[ 메 뉴 ]");
            console.log("  1. VOD 검색 및 다운로드");
            console.log(`  2. 설정  (속도: ${speedLabel} / 방식: ${concLabel})`);
            console.log("  0. 종료");

            const choice = await this.ask("\n선택 > ");

            if (choice === "0") {
                console.log("\n종료합니다.");
                break;
            } else if (choice === "1") {
                await this.runDownloadFlow();
            } else if (choice === "2") {
                await this.runSettingsFlow();
            } else {
                console.log("올바른 번호를 입력해주세요.\n");
            }
        }

        this.rl.close();
    }
}

// ─────────────────────────────────────────────
//  실행
// ─────────────────────────────────────────────

async function main(): Promise<void> {
    const downloader = new SoopVodDownloader();
    await downloader.run();
}

main().catch((err) => {
    console.error("치명적 오류:", err);
    process.exit(1);
});
