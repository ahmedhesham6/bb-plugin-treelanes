import { cn } from "../lib/utils";

const PROJECT_COLORS = [
  { value: "gray", className: "text-gray-600 dark:text-gray-400" },
  { value: "red", className: "text-red-600 dark:text-red-400" },
  { value: "orange", className: "text-orange-600 dark:text-orange-400" },
  { value: "amber", className: "text-amber-600 dark:text-amber-400" },
  { value: "yellow", className: "text-yellow-600 dark:text-yellow-400" },
  { value: "lime", className: "text-lime-600 dark:text-lime-400" },
  { value: "green", className: "text-green-600 dark:text-green-400" },
  { value: "emerald", className: "text-emerald-600 dark:text-emerald-400" },
  { value: "teal", className: "text-teal-600 dark:text-teal-400" },
  { value: "cyan", className: "text-cyan-600 dark:text-cyan-400" },
  { value: "sky", className: "text-sky-600 dark:text-sky-400" },
  { value: "blue", className: "text-blue-600 dark:text-blue-400" },
  { value: "indigo", className: "text-indigo-600 dark:text-indigo-400" },
  { value: "violet", className: "text-violet-600 dark:text-violet-400" },
  { value: "purple", className: "text-purple-600 dark:text-purple-400" },
  { value: "fuchsia", className: "text-fuchsia-600 dark:text-fuchsia-400" },
  { value: "pink", className: "text-pink-600 dark:text-pink-400" },
  { value: "rose", className: "text-rose-600 dark:text-rose-400" },
] as const;

type ProjectColor = (typeof PROJECT_COLORS)[number]["value"];

const normalize = (name: string) => name.normalize("NFKC").trim();

function projectMonogram(name: string): string {
  const words = normalize(name).match(/[\p{L}\p{N}]+/gu) ?? [];
  const firstWord = words[0];
  if (!firstWord) return "PR";
  const glyphs = Array.from(firstWord);
  const first = glyphs[0] ?? "P";
  const second =
    glyphs.slice(1).find((glyph) => /\p{N}/u.test(glyph)) ??
    (words.length > 1 ? Array.from(words.at(-1) ?? "")[0] : glyphs.at(-1)) ??
    first;
  return Array.from(`${first}${second}`.toUpperCase()).slice(0, 2).join("");
}

function projectColor(name: string): ProjectColor {
  const seed = normalize(name).toLocaleLowerCase("en-US") || "project";
  let index = 0;
  for (const glyph of seed) {
    index = (index * 31 + (glyph.codePointAt(0) ?? 0)) % PROJECT_COLORS.length;
  }
  return PROJECT_COLORS[index]?.value ?? "blue";
}

/** T3 Code's project initials and color, so the same project looks the same in both apps. */
export function projectIdentity(name: string) {
  return { monogram: projectMonogram(name), color: projectColor(name) };
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function ProjectChip({ name }: { name: string }) {
  const { monogram, color } = projectIdentity(name);
  const colorClass = PROJECT_COLORS.find((c) => c.value === color)!.className;
  return (
    <span
      aria-hidden="true"
      data-project-chip=""
      className="inline-flex size-4 shrink-0 items-center justify-center"
    >
      <svg
        viewBox="0 0 16 16"
        className={cn(
          "size-full overflow-hidden rounded-[25%] font-mono select-none",
          colorClass,
        )}
        style={{
          backgroundColor: "color-mix(in srgb, currentColor 14%, transparent)",
        }}
      >
        <text
          x="8"
          y="10.8"
          textAnchor="middle"
          fill="currentColor"
          fontSize="8.25"
          fontWeight="700"
          textLength={Array.from(segmenter.segment(monogram)).length === 1 ? 6 : 12}
          lengthAdjust="spacingAndGlyphs"
          textRendering="geometricPrecision"
        >
          {monogram}
        </text>
      </svg>
    </span>
  );
}
