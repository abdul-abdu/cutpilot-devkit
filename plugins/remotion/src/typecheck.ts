/**
 * The fast check after a scene is written: the project's own TypeScript, with the project's own
 * tsconfig, over the scene and index.tsx. Only errors in src/cutpilot are reported (the user's
 * other files are theirs); they come back as tsc prints them, for the AI to fix its own code.
 */
import { dirname, resolve, sep } from 'node:path';
import type * as TS from 'typescript';
import { projectRequire } from './project.js';
import { scenesDir } from './scenes.js';

export interface TypecheckResult {
  /** false when the project has no TypeScript (a plain JS project): nothing was checked */
  ran: boolean;
  ok: boolean;
  /** tsc's messages, `src/cutpilot/intro.tsx(4,7): error TS2322: …` */
  errors: string[];
}

export function typecheckScenes(projectDir: string, files: string[]): TypecheckResult {
  let ts: typeof TS;
  try {
    ts = projectRequire(projectDir)('typescript') as typeof TS;
  } catch {
    return { ran: false, ok: true, errors: [] };
  }
  const configFile = ts.findConfigFile(projectDir, (f) => ts.sys.fileExists(f), 'tsconfig.json');
  let options: TS.CompilerOptions = {
    jsx: ts.JsxEmit.ReactJSX,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    esModuleInterop: true,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2018,
  };
  if (configFile) {
    const read = ts.readConfigFile(configFile, (f) => ts.sys.readFile(f));
    if (!read.error)
      options = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configFile)).options;
  }
  options = { ...options, noEmit: true, incremental: false, composite: false };
  const program = ts.createProgram({ rootNames: files, options });
  const ours = resolve(scenesDir(projectDir)) + sep;
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.category === ts.DiagnosticCategory.Error)
    .filter((d) => !d.file || resolve(d.file.fileName).startsWith(ours));
  const host: TS.FormatDiagnosticsHost = {
    getCanonicalFileName: (f) => f,
    getCurrentDirectory: () => projectDir,
    getNewLine: () => '\n',
  };
  const errors = diagnostics.map((d) => ts.formatDiagnostic(d, host).trim());
  return { ran: true, ok: errors.length === 0, errors: errors.slice(0, 30) };
}
