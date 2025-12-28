declare module 'node:fs/promises' {
  const fs: {
    readFile(path: string, encoding: string): Promise<string>;
    writeFile(path: string, data: string, encoding: string): Promise<void>;
    mkdir(path: string, options: { recursive?: boolean }): Promise<void>;
  };
  export default fs;
}

declare module 'node:path' {
  const path: {
    basename(path: string, ext?: string): string;
    extname(path: string): string;
    dirname(path: string): string;
    join(...parts: string[]): string;
    resolve(...parts: string[]): string;
    posix: {
      join(...parts: string[]): string;
    };
  };
  export default path;
}

declare module 'node:process' {
  const process: {
    argv: string[];
    cwd(): string;
    exit(code?: number): never;
    env: Record<string, string | undefined>;
  };
  export default process;
}

declare module 'js-yaml' {
  const yaml: {
    dump(data: unknown, options?: Record<string, unknown>): string;
    load(content: string): unknown;
  };
  export default yaml;
}

declare namespace NodeJS {
  interface ErrnoException extends Error {
    code?: string;
  }
}

interface Console {
  log(...data: unknown[]): void;
  warn(...data: unknown[]): void;
  error(...data: unknown[]): void;
}

declare const console: Console;
