const DEFAULT_TAIL = 10;
const MAX_SEGMENT_TAIL = 16;
const MIN_WORD_TAIL = 4;
const WORD_BREAK = /[-_./]/;

/** T3 Code's split: keep the last path segment or word whole in the tail. */
export function splitForMiddleTruncate(
  value: string,
): { head: string; tail: string } | null {
  const chars = Array.from(value);
  let keep = DEFAULT_TAIL;
  const slash = chars.lastIndexOf("/");
  if (slash > 0 && slash < chars.length - 1) {
    const segment = chars.length - slash - 1;
    keep = segment <= MAX_SEGMENT_TAIL ? segment : DEFAULT_TAIL;
  }
  if (chars.length <= keep + 4) return null;
  let cut = chars.length - keep;
  if (!WORD_BREAK.test(chars[cut - 1]!)) {
    const startsWord = (index: number) => WORD_BREAK.test(chars[index - 1]!);
    let snapped = -1;
    for (let index = cut + 1; index <= chars.length - MIN_WORD_TAIL; index++) {
      if (startsWord(index)) {
        snapped = index;
        break;
      }
    }
    for (
      let index = cut - 1;
      snapped < 0 && index >= chars.length - MAX_SEGMENT_TAIL && index > 4;
      index--
    ) {
      if (startsWord(index)) snapped = index;
    }
    if (snapped > 0) cut = snapped;
  }
  return { head: chars.slice(0, cut).join(""), tail: chars.slice(cut).join("") };
}

function collapseSegments(split: { head: string; tail: string }) {
  const collapse = (text: string) => text.replace(/[ \t\n\r\f]+/g, " ");
  const head = collapse(split.head).replace(/^ /, "");
  const tail = collapse(split.tail).replace(/ $/, "");
  return { head, tail: head.endsWith(" ") ? tail.replace(/^ /, "") : tail };
}

export function MiddleTruncate({ value }: { value: string }) {
  const raw = splitForMiddleTruncate(value);
  const split = raw && collapseSegments(raw);
  return (
    <span
      title={value}
      className="inline-flex min-w-0 max-w-full overflow-hidden whitespace-nowrap"
    >
      {split ? (
        <>
          <span className="min-w-0 truncate whitespace-pre">{split.head}</span>
          <span className="shrink-0 whitespace-pre">{split.tail}</span>
        </>
      ) : (
        <span className="min-w-0 truncate">{value}</span>
      )}
    </span>
  );
}
