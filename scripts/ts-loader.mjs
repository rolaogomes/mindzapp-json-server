import { access, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import ts from 'typescript';

const compilerOptions = {
  module: ts.ModuleKind.ESNext,
  target: ts.ScriptTarget.ES2022,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  esModuleInterop: true,
  resolveJsonModule: true,
  isolatedModules: true,
  jsx: ts.JsxEmit.React,
};

export async function load(url, context, defaultLoad) {
  if (url.endsWith('.ts') || url.endsWith('.tsx')) {
    const filePath = url.startsWith('file://') ? fileURLToPath(url) : url;
    const source = await readFile(filePath, 'utf8');
    const transpiled = ts.transpileModule(source, { compilerOptions, fileName: filePath });
    return {
      format: 'module',
      source: transpiled.outputText,
      shortCircuit: true,
    };
  }

  return defaultLoad(url, context, defaultLoad);
}

async function fileExists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

export async function resolve(specifier, context, defaultResolve) {
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file://')) {
    const parentPath = fileURLToPath(context.parentURL);
    const baseDir = path.dirname(parentPath);
    const resolvedBase = path.resolve(baseDir, specifier);
    const extensions = ['.ts', '.tsx', '.js', '.mjs', '.cjs'];

    for (const ext of extensions) {
      const candidate = resolvedBase.endsWith(ext) ? resolvedBase : resolvedBase + ext;
      if (await fileExists(candidate)) {
        return {
          url: pathToFileURL(candidate).href,
          shortCircuit: true,
        };
      }
    }
  }

  return defaultResolve(specifier, context, defaultResolve);
}