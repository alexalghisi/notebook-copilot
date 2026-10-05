import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";

export interface ServerProcess {
    url: string;
    process: ChildProcess;
    output(): string;
    stop(): Promise<void>;
}

const ROOT = join(import.meta.dirname, "..", "..");

/** Starts `src/server/main.ts` as a real child process and resolves once it is listening. */
export async function startServerProcess(env: Record<string, string>): Promise<ServerProcess> {
    const child = spawn(process.execPath, ["--import", "tsx", "src/server/main.ts"], {
        cwd: ROOT,
        env: { ...process.env, PORT: "0", ...env },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));

    const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 20_000);
        const onData = () => {
            const match = /listening on (http:\/\/\S+)/.exec(output);
            if (match?.[1]) {
                clearTimeout(timer);
                resolve(match[1]);
            }
        };
        child.stdout.on("data", onData);
        child.once("exit", (code) => {
            clearTimeout(timer);
            reject(new Error(`server exited with ${code}:\n${output}`));
        });
    });

    return {
        url,
        process: child,
        output: () => output,
        async stop() {
            if (child.exitCode !== null) return;
            child.kill("SIGTERM");
            await once(child, "exit");
        },
    };
}
