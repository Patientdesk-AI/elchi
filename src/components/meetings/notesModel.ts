/**
 * A meeting's notes as the server writes them (POST /v1/elchi/notes): a "# " title,
 * "## " sections, "- " bullets and "- [ ] " to-dos. A section whose heading is one of the
 * user's own lines is theirs: they wrote the heading, Eshlik wrote what is under it.
 * Lenient about the model's slips ("- - [ ]", trailing spaces).
 */

export type Line =
  | { kind: "bullet"; text: string; at: number }
  | { kind: "task"; text: string; done: boolean; at: number }
  | { kind: "text"; text: string; at: number };

export interface Section {
  heading: string | null;
  mine: boolean;
  lines: Line[];
  /** Every line a to-do: the action items. */
  tasks: boolean;
}

/** A note line as the user might retype it: case, list marks and end punctuation aside. */
export const sameLine = (s: string) =>
  s
    .toLocaleLowerCase()
    .replace(/^[\s\-*•·]+/, "")
    .replace(/^\d+[.)]\s*/, "")
    .replace(/[\s.?!:;,]+$/, "")
    .replace(/\s+/g, " ")
    .trim();

const TASK = /^(?:[-*•]\s+)*[-*•]?\s*\[( |x|X)\]\s*(.*)$/;
const BULLET = /^(?:[-*•]\s+)+(.*)$/;

export const parseNotes = (markdown: string, userNotes: string): Section[] => {
  const mine = new Set(userNotes.split("\n").map(sameLine).filter(Boolean));
  const sections: Section[] = [];
  let current: Section | null = null;
  const open = (heading: string | null) => {
    current = {
      heading,
      mine: heading !== null && mine.has(sameLine(heading)),
      lines: [],
      tasks: false,
    };
    sections.push(current);
    return current;
  };
  markdown.split("\n").forEach((raw, at) => {
    const t = raw.trim();
    if (!t) return;
    if (t.startsWith("#")) {
      // The "# " title is shown on its own; sections start at "## ".
      if (/^#\s/.test(t)) return;
      open(t.replace(/^#+\s*/, ""));
      return;
    }
    const section: Section = current ?? open(null);
    const task = t.match(TASK);
    if (task) {
      section.lines.push({
        kind: "task",
        text: task[2].trim(),
        done: task[1] !== " ",
        at,
      });
      return;
    }
    const bullet = t.match(BULLET);
    section.lines.push(
      bullet
        ? { kind: "bullet", text: bullet[1].trim(), at }
        : { kind: "text", text: t, at },
    );
  });
  for (const s of sections)
    s.tasks = s.lines.length > 0 && s.lines.every((l) => l.kind === "task");
  return sections.filter((s) => s.heading !== null || s.lines.length > 0);
};

/** The notes with the to-do on line `at` ticked or unticked. */
export const toggleTask = (markdown: string, at: number) =>
  markdown
    .split("\n")
    .map((line, i) =>
      i !== at
        ? line
        : line.replace(/\[( |x|X)\]/, (_, mark: string) =>
            mark === " " ? "[x]" : "[ ]",
          ),
    )
    .join("\n");

const plain = (s: string) => s.replace(/\*\*(.+?)\*\*/g, "$1");

/** Two lines for the meetings list: the first points of the notes, to-dos aside. */
export const summaryOf = (markdown: string | null) => {
  if (!markdown) return "";
  const points = parseNotes(markdown, "")
    .filter((s) => !s.tasks)
    .flatMap((s) => s.lines.filter((l) => l.kind !== "task"))
    .slice(0, 2)
    .map((l) => plain(l.text).replace(/[.;]?$/, "."));
  return points.join(" ");
};

export const openTasks = (markdown: string | null) =>
  markdown
    ? parseNotes(markdown, "")
        .flatMap((s) => s.lines)
        .filter((l) => l.kind === "task" && !l.done).length
    : 0;
