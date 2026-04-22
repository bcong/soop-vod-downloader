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
    viewCount: number;
    url: string;
}

// ─────────────────────────────────────────────
//  유틸리티
// ─────────────────────────────────────────────

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
    ucc?: { total_file_duration?: number };
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

class SoopVodDownloader {
    private rl: readline.Interface;
    private http: AxiosInstance;

    constructor() {
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

    private downloadOne(vod: VodItem, outputDir: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const safeName = sanitizeFilename(vod.title);
            const outTemplate = path.join(outputDir, `${safeName}.%(ext)s`);
            // 완료 후 파일 존재 확인용 경로 (항상 mp4)
            const expectedFile = path.join(outputDir, `${safeName}.mp4`);

            const ffmpegPath = this.resolveFfmpegPath();

            const args = [
                vod.url,
                "-o",
                outTemplate,
                "--no-playlist",
                "--progress",
                "--no-warnings",
                "--newline", // 진행률을 줄바꿈 단위로 출력
                "--merge-output-format",
                "mp4", // 세그먼트/스트림 병합 후 단일 mp4
                "--concurrent-fragments",
                "4", // HLS 세그먼트 병렬 다운로드
                ...(ffmpegPath ? ["--ffmpeg-location", ffmpegPath] : []),
            ];

            const ytDlpPath = this.resolveYtDlpPath();
            const proc = spawn(ytDlpPath, args, { stdio: ["ignore", "pipe", "pipe"] });

            proc.stdout.on("data", (chunk: Buffer) => {
                const line = chunk.toString().replace(/\r?\n$/, "");
                if (line.includes("[download]") || line.includes("%")) {
                    process.stdout.write(`\r    ${line.substring(0, 72).padEnd(72)}`);
                }
            });

            proc.stderr.on("data", (chunk: Buffer) => {
                const line = chunk.toString().trim();
                if (line && !line.startsWith("WARNING") && !line.startsWith("[debug]")) {
                    process.stderr.write(`\n    [경고] ${line}\n`);
                }
            });

            proc.on("close", (code) => {
                process.stdout.write("\n");
                if (code === 0) {
                    resolve();
                    return;
                }
                // exit code != 0 이어도 파일이 생성됐으면 성공으로 간주
                // (ffprobe 미설치 등 메타데이터 관련 오류는 파일 자체에 영향 없음)
                if (fs.existsSync(expectedFile) && fs.statSync(expectedFile).size > 0) {
                    resolve();
                    return;
                }
                reject(new Error(`yt-dlp 종료 코드 ${code}`));
            });

            proc.on("error", (err) => {
                reject(new Error(`프로세스 실행 실패: ${err.message}`));
            });
        });
    }

    // ── 목록 출력 ─────────────────────────────

    private printVodTable(vods: VodItem[], from: number, to: number): void {
        const BAR = "─".repeat(72);
        console.log(`\n┌${BAR}┐`);
        console.log(`│ ${"#".padStart(4)}  ${"제목".padEnd(42)} ${"날짜".padEnd(12)} ${"길이".padEnd(8)} │`);
        console.log(`├${BAR}┤`);

        for (const vod of vods.slice(from - 1, to)) {
            const num = String(vod.index).padStart(4);
            const title = vod.title.substring(0, 41).padEnd(42);
            const date = vod.date.padEnd(12);
            const dur = vod.duration.padEnd(8);
            console.log(`│ ${num}  ${title} ${date} ${dur} │`);
        }

        console.log(`└${BAR}┘`);
    }

    // ── 메인 플로우 ───────────────────────────

    private async runDownloadFlow(): Promise<void> {
        const userId = await this.ask("\n스트리머 아이디 입력: ");
        if (!userId) {
            console.log("아이디를 입력해주세요.");
            return;
        }

        // 1) 전체 VOD 목록 수집
        const vods = await this.fetchAllVods(userId);
        if (vods.length === 0) return;

        console.log(`\n총 ${vods.length}개의 VOD를 찾았습니다.`);
        console.log(`  1번 (최신)  : ${vods[0].title}  [${vods[0].date}]`);
        console.log(
            `  ${vods.length}번 (가장 오래됨): ${vods[vods.length - 1].title}  [${vods[vods.length - 1].date}]`,
        );

        // 2) 범위 입력 (두 번)
        console.log(`\n다운로드할 번호 범위를 입력하세요 (1 = 최신, ${vods.length} = 가장 오래됨)`);
        let from: number;
        let to: number;

        while (true) {
            from = await this.askInt(`  시작 번호 (1 ~ ${vods.length}): `, 1, vods.length);
            to = await this.askInt(`  끝   번호 (1 ~ ${vods.length}): `, 1, vods.length);

            if (from > to) {
                console.log("  ⚠  시작 번호가 끝 번호보다 큽니다. 다시 입력해주세요.");
                continue;
            }
            break;
        }

        // 3) 선택한 범위 미리보기
        this.printVodTable(vods, from, to);
        const count = to - from + 1;
        console.log(`\n${from}번 ~ ${to}번, 총 ${count}개를 다운로드합니다.`);

        const ok = await this.ask("계속하시겠습니까? (y/n): ");
        if (ok.toLowerCase() !== "y") {
            console.log("취소되었습니다.\n");
            return;
        }

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
        const defaultOutputDir = path.join(process.cwd(), "downloads", userId);
        console.log(`\n기본 저장 경로: ${defaultOutputDir}`);
        const inputDir = await this.ask(`저장 경로 입력 (엔터 = 기본값 사용): `);
        const outputDir = inputDir ? path.resolve(inputDir.trim()) : defaultOutputDir;
        fs.mkdirSync(outputDir, { recursive: true });
        console.log(`\n저장 경로: ${outputDir}`);
        console.log(`yt-dlp  : ${this.resolveYtDlpPath()}`);
        const ffmpegPath = this.resolveFfmpegPath();
        console.log(`ffmpeg  : ${ffmpegPath ?? "(PATH에서 자동 탐색)"}\n`);

        // 6) 순차 다운로드
        const selected = vods.slice(from - 1, to);
        let successCount = 0;
        let failCount = 0;

        for (let i = 0; i < selected.length; i++) {
            const vod = selected[i];
            console.log(`[${i + 1}/${selected.length}] #${vod.index}: ${vod.title}`);
            console.log(`  URL: ${vod.url}`);

            try {
                await this.downloadOne(vod, outputDir);
                console.log("  ✓ 완료\n");
                successCount++;
            } catch (err: unknown) {
                console.error(`  ✗ 실패: ${(err as Error).message}\n`);
                failCount++;
            }

            if (i < selected.length - 1) {
                await delay(500);
            }
        }

        // 7) 결과 요약
        const sep = "═".repeat(44);
        console.log(sep);
        console.log(`다운로드 완료  성공: ${successCount}개  /  실패: ${failCount}개`);
        console.log(`저장 위치: ${outputDir}`);
        console.log(sep + "\n");
    }

    // ── 루프 진입점 ───────────────────────────

    async run(): Promise<void> {
        while (true) {
            console.log("[ 메 뉴 ]");
            console.log("  1. VOD 검색 및 다운로드");
            console.log("  0. 종료");

            const choice = await this.ask("\n선택 > ");

            if (choice === "0") {
                console.log("\n종료합니다.");
                break;
            } else if (choice === "1") {
                await this.runDownloadFlow();
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
