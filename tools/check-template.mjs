import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync, statSync} from 'node:fs';
import {dirname, extname, isAbsolute, join, normalize, relative, resolve} from 'node:path';

const root = resolve(import.meta.dirname, '..');
const errors = [];
const warnings = [];
const knownArguments = new Set(['--require-tracked']);
const argumentsFromCli = process.argv.slice(2);
const requireTracked = argumentsFromCli.includes('--require-tracked');

for (const argument of argumentsFromCli) {
  if (!knownArguments.has(argument)) {
    errors.push(`不明なオプションです: ${argument}`);
  }
}

const requiredFiles = [
  'README.md',
  'HANDOFF.md',
  'STATUS.md',
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  'ROADMAP.md',
  'WORKLOG.md',
  '.github/copilot-instructions.md',
  'docs/PROJECT_BRIEF.md',
  'docs/REQUIREMENTS.md',
  'docs/VERSIONING.md',
  'docs/RESOURCES.md',
  'docs/AI_COMPATIBILITY.md',
  'docs/ARCHITECTURE.md',
  'docs/TESTING.md',
  'docs/SECURITY.md',
];

for (const file of requiredFiles) {
  if (!existsSync(join(root, file))) {
    errors.push(`必須ファイルがありません: ${file}`);
  }
}

// AIごとの入口は、AGENTS.mdの複製ではなく薄いimportだけに保つ。
// 内容をコピーすると、片方だけ古くなったり、複数読込時に規則が競合したりする。
const instructionAdapters = new Map([
  ['CLAUDE.md', '@AGENTS.md'],
  ['GEMINI.md', '@./AGENTS.md'],
  [
    '.github/copilot-instructions.md',
    'For every task in this repository, open and read the repository-root AGENTS.md first. Treat it as the only canonical instructions and follow it before acting.',
  ],
]);

for (const [file, expected] of instructionAdapters) {
  const absolute = join(root, file);
  if (!existsSync(absolute)) continue;

  const actual = readFileSync(absolute, 'utf8').trim();
  if (actual !== expected) {
    errors.push(
      `${file}はAI別の薄い入口だけにしてください。期待値: ${expected}`,
    );
  }
}

let trackedFiles = [];
try {
  trackedFiles = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard'],
    {
      cwd: root,
      encoding: 'utf8',
    },
  )
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
} catch (error) {
  errors.push(`git ls-files を実行できません: ${error.message}`);
}

if (requireTracked) {
  let cachedFiles = [];
  try {
    cachedFiles = execFileSync('git', ['ls-files', '--cached'], {
      cwd: root,
      encoding: 'utf8',
    })
      .split(/\r?\n/u)
      .map((line) => line.trim().replaceAll('\\', '/'))
      .filter(Boolean);
  } catch (error) {
    errors.push(`追跡済みファイルの確認を実行できません: ${error.message}`);
  }

  const cachedFileSet = new Set(cachedFiles);
  for (const file of requiredFiles) {
    if (existsSync(join(root, file)) && !cachedFileSet.has(file)) {
      errors.push(`必須ファイルがGitの追跡対象に入っていません: ${file}`);
    }
  }
}

// .gitignore の「Secrets and local configuration」と対応させる。
// 片方だけへ追加すると、除外しているつもりのものを検査が見逃す。
const forbiddenTrackedNames = [
  // .env.exampleだけは架空値を置く見本なので除く
  // （.gitignore の !.env.example と docs/SECURITY.md の指示に合わせる）
  /(^|\/)\.env(?:$|\.(?!example$))/iu,
  /(^|\/)(?:credentials|token|tokens)\.json$/iu,
  /(^|\/)client_secret[^/]*\.json$/iu,
  /(^|\/)oauth-(?:client|token)[^/]*\.json$/iu,
  /\.(?:pem|key|p12|pfx)$/iu,
];

for (const file of trackedFiles) {
  if (forbiddenTrackedNames.some((pattern) => pattern.test(file))) {
    errors.push(`秘密情報を含み得るファイル名がGit管理対象に入っています: ${file}`);
  }
}

const textExtensions = new Set([
  '', '.c', '.cc', '.conf', '.cpp', '.css', '.go', '.h', '.hpp', '.html',
  '.ini', '.java', '.js', '.json', '.jsx', '.md', '.mjs', '.py', '.rb',
  '.rs', '.sh', '.toml', '.ts', '.tsx', '.txt', '.yaml', '.yml',
]);

const isScannableText = (file) => (
  /(^|\/)\.env\.example$/iu.test(file) ||
  textExtensions.has(extname(file).toLowerCase())
);

const secretPatterns = [
  ['秘密鍵', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u],
  ['GitHub token', /(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/u],
  ['Google API key', /AIza[0-9A-Za-z_-]{30,}/u],
  ['一般的なsecret key', /\bsk-[A-Za-z0-9_-]{20,}\b/u],
  ['Windows利用者パス', /\b[A-Za-z]:[\\/]Users[\\/][^\\/\s]+/u],
  ['macOS利用者パス', /(?<![A-Za-z]:)\/Users\/[^/\s]+/u],
  ['Linux利用者パス', /\/home\/[^/\s]+/u],
];

const markdownLinkPattern = /\[[^\]]*\]\(([^)]+)\)/gu;

for (const file of trackedFiles) {
  const absolute = join(root, file);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) continue;
  if (!isScannableText(file)) continue;

  let text;
  try {
    text = readFileSync(absolute, 'utf8');
  } catch {
    continue;
  }

  for (const [label, pattern] of secretPatterns) {
    if (pattern.test(text)) {
      errors.push(`${label}らしい文字列があります: ${file}`);
    }
  }

  if (extname(file).toLowerCase() !== '.md') continue;

  for (const match of text.matchAll(markdownLinkPattern)) {
    const target = match[1].trim();
    if (
      target.startsWith('http://') ||
      target.startsWith('https://') ||
      target.startsWith('mailto:') ||
      target.startsWith('#')
    ) {
      continue;
    }

    let withoutAnchor;
    try {
      withoutAnchor = decodeURIComponent(target.split('#', 1)[0]);
    } catch {
      errors.push(`URLエンコードが不正なリンクです: ${file} -> ${target}`);
      continue;
    }
    if (!withoutAnchor) continue;

    const resolved = normalize(resolve(dirname(absolute), withoutAnchor));
    const fromRoot = relative(root, resolved);
    if (fromRoot.startsWith('..') || isAbsolute(fromRoot) || !existsSync(resolved)) {
      errors.push(`相対リンクの参照先がありません: ${file} -> ${target}`);
    }
  }
}

if (!existsSync(join(root, 'LICENSE'))) {
  warnings.push('LICENSEは未選択です。公開・再利用を許可する前に人が決めてください。');
}

const placeholderFiles = trackedFiles.filter((file) => {
  const absolute = join(root, file);
  if (!existsSync(absolute) || extname(file).toLowerCase() !== '.md') return false;
  return /【[^】]+】/u.test(readFileSync(absolute, 'utf8'));
});

if (placeholderFiles.length > 0) {
  warnings.push(
    `プロジェクト固有の記入欄が残っています（テンプレート本体では正常）: ${placeholderFiles.join(', ')}`,
  );
}

for (const warning of warnings) {
  console.warn(`WARN: ${warning}`);
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`ERROR: ${error}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `OK: Git管理対象・未追跡の${trackedFiles.length}個を確認し、公開を止める問題は見つかりませんでした。`,
  );
}
