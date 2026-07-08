import { copyFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TOOL } from "./digest.js";
import { configDir } from "./locate.js";

/** Absolute runtime + script path, not bare "unforget": GUI-launched hooks get a minimal PATH
 * that often lacks the npm global bin, and a PATH miss is a silently dead hook. */
export function hookCommand(): string {
  const script = process.argv[1];
  return script ? `"${process.execPath}" "${script}" inject` : `${TOOL} inject`;
}

export function hookEntry() {
  return { matcher: "compact", hooks: [{ type: "command", command: hookCommand() }] };
}

// Loose settings.json shape; we only touch hooks.SessionStart, everything else passes through.
interface HookEntry {
  matcher?: string;
  hooks?: { command?: string }[];
}
export interface Settings {
  hooks?: { SessionStart?: HookEntry[] } & Record<string, unknown>;
  [k: string]: unknown;
}

// Hand-edited settings: read defensively, never crash.
function hookList(s: Settings): HookEntry[] {
  const raw = s.hooks?.SessionStart;
  return Array.isArray(raw) ? raw : [];
}

// Ours = any command mentioning the tool and "inject" (absolute-path or bare `unforget inject`).
function ourCommand(e: HookEntry): string | null {
  if (!Array.isArray(e?.hooks)) return null;
  const h = e.hooks.find(
    (h) =>
      typeof h?.command === "string" && h.command.includes(TOOL) && h.command.includes("inject"),
  );
  return h?.command ?? null;
}

function ours(e: HookEntry): boolean {
  return ourCommand(e) !== null;
}

export function isInstalled(s: Settings): boolean {
  return hookList(s).some(ours);
}

/** Command string of our installed hook entry, or null when not installed (doctor checks it). */
export function installedCommand(s: Settings): string | null {
  for (const e of hookList(s)) {
    const c = ourCommand(e);
    if (c) return c;
  }
  return null;
}

/** Returns new settings with our hook appended (or null when already installed). */
export function withHook(s: Settings): Settings | null {
  if (isInstalled(s)) return null;
  const next: Settings = { ...s, hooks: { ...s.hooks } };
  next.hooks!.SessionStart = [...hookList(s), hookEntry()];
  return next;
}

/** Returns new settings with our hook removed (or null when not installed). */
export function withoutHook(s: Settings): Settings | null {
  if (!isInstalled(s)) return null;
  const next: Settings = { ...s, hooks: { ...s.hooks } };
  const kept = hookList(s).filter((e) => !ours(e));
  if (kept.length > 0) next.hooks!.SessionStart = kept;
  else delete next.hooks!.SessionStart;
  if (Object.keys(next.hooks!).length === 0) delete next.hooks;
  return next;
}

export function settingsPath(): string {
  return join(configDir(), "settings.json");
}

/** Install/remove, writing through symlinks: settings.json is often a symlink into a dotfiles
 * repo, and replacing the link instead of its target would silently detach it. Leaves a .bak. */
export function applyInit(path: string, remove: boolean, confirm: (msg: string) => boolean): void {
  const real = existsSync(path) ? realpathSync(path) : path;
  let current: Settings = {};
  if (existsSync(real)) {
    try {
      current = JSON.parse(readFileSync(real, "utf8"));
    } catch {
      process.stderr.write(`${real} is not valid JSON — fix it first, nothing written\n`);
      process.exitCode = 1;
      return;
    }
  }

  // Unexpected hooks shape: refuse, tell the user, write nothing.
  const h = current.hooks;
  const badHooks = h !== undefined && (typeof h !== "object" || h === null || Array.isArray(h));
  const ss = badHooks ? undefined : h?.SessionStart;
  if (badHooks || (ss !== undefined && !Array.isArray(ss))) {
    process.stderr.write(`${real} has an unexpected hooks shape — fix it first, nothing written\n`);
    process.exitCode = 1;
    return;
  }

  const next = remove ? withoutHook(current) : withHook(current);
  if (!next) {
    console.log(
      remove
        ? `${TOOL} hook not present in ${real} — nothing to do`
        : `${TOOL} hook already installed in ${real}`,
    );
    return;
  }

  const verb = remove ? "remove from" : "add to";
  let change = `will ${verb} ${real}${real === path ? "" : ` (via ${path})`}:\n${JSON.stringify(hookEntry(), null, 2)}\n(everything else is left untouched)`;
  // Runtime paths that move on upgrade (npx/bunx caches, Homebrew, nvm/mise node): warn, don't block.
  if (
    !remove &&
    /\/_npx\/|\/\.bun\/install\/cache\/|\/Cellar\/|\/(nvm|mise)\/|\/versions\/node\//.test(
      hookCommand(),
    )
  ) {
    change += `\nWARNING: this command uses an npx/bunx cache or a version-pinned runtime path (Homebrew/nvm/mise)\nthat can vanish on upgrade or cache clean, silently killing the hook.\nPrefer \`npm install -g ${TOOL}\` (then re-run init), or re-run init after upgrades.`;
  }
  if (!confirm(change)) {
    console.log("aborted, nothing written");
    return;
  }

  const hadFile = existsSync(real);
  if (hadFile) copyFileSync(real, `${real}.${TOOL}.bak`);
  writeFileSync(real, `${JSON.stringify(next, null, 2)}\n`);
  console.log(
    `${remove ? "removed" : "installed"} — ${hadFile ? `backup at ${real}.${TOOL}.bak` : `created ${real}`}`,
  );
}
