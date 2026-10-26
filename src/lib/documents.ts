import fs from "fs";
import PDFDocument from "pdfkit";
import { getDb } from "./db";
import type { Session } from "./memory";

// Files in and out. Friends send her a PDF or Word file; its text is stored
// and shown to her for a while so she can work with it. When she organizes
// something she writes it between [文档:标题] and [/文档]; that block is cut
// out of her chat reply and sent as a PDF file instead.

// How long a received file stays in her prompt, and how much of it.
const DOC_WINDOW_MS = 6 * 3600 * 1000;
const DOC_PROMPT_CHARS = 40_000;
const MAX_DOCS = 2;

export const READABLE = /\.(pdf|docx)$/i;

// ---------- reading ----------

async function pdfText(buf: Buffer): Promise<{ text: string; pages: number }> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const pages = (text as string[]).map((t, i) => `【第${i + 1}页】\n${t.trim()}`);
  return { text: pages.join("\n\n"), pages: totalPages };
}

async function docxText(buf: Buffer): Promise<string> {
  const mammoth = await import("mammoth");
  return (await mammoth.extractRawText({ buffer: buf })).value;
}

/** Text of a PDF or .docx; throws with a reason she can repeat. */
export async function extractDocument(buf: Buffer, name: string): Promise<{ text: string; summary: string }> {
  if (/\.pdf$/i.test(name)) {
    const { text, pages } = await pdfText(buf);
    const chars = text.replace(/【第\d+页】|\s/g, "").length;
    // Scanned PDFs have pages but (almost) no text layer.
    if (chars < pages * 20) throw new Error(`这个 PDF 像是扫描或拍照的，${pages} 页里几乎没有能读的文字`);
    return { text, summary: `${pages} 页，约 ${chars} 字` };
  }
  if (/\.docx$/i.test(name)) {
    const text = (await docxText(buf)).trim();
    if (!text) throw new Error("这个 Word 文档里没读到文字");
    return { text, summary: `约 ${text.replace(/\s/g, "").length} 字` };
  }
  throw new Error("这种文件打不开，只能看 PDF 和 Word（.docx）");
}

export function saveDocument({ userId, companion }: Session, name: string, text: string) {
  getDb()
    .prepare(`INSERT INTO documents (user_id, companion, name, text, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(userId, companion, name, text, Date.now());
}

export type StoredDocument = { name: string; text: string; created_at: number };

/** Files this person sent recently, newest last, trimmed to fit the prompt. */
export function recentDocuments({ userId, companion }: Session): StoredDocument[] {
  const docs = getDb()
    .prepare(
      `SELECT name, text, created_at FROM documents
       WHERE user_id = ? AND companion = ? AND created_at >= ?
       ORDER BY id DESC LIMIT ?`
    )
    .all(userId, companion, Date.now() - DOC_WINDOW_MS, MAX_DOCS)
    .reverse() as StoredDocument[];
  const each = Math.floor(DOC_PROMPT_CHARS / Math.max(1, docs.length));
  return docs.map((d) => ({
    ...d,
    text: d.text.length > each ? d.text.slice(0, each) + "\n…（后面太长，没放进来）" : d.text,
  }));
}

// ---------- writing ----------

export type Draft = { title: string; body: string };

const DOC_BLOCK = /\[文档[:：]\s*([^\]\n]*)\]\s*\n([\s\S]*?)\n?\s*\[\/文档\]/g;

/** Cut [文档:标题]…[/文档] blocks out of a reply. */
export function takeDrafts(reply: string): { rest: string; drafts: Draft[] } {
  const drafts: Draft[] = [];
  const rest = reply.replace(DOC_BLOCK, (_, title: string, body: string) => {
    drafts.push({ title: title.trim() || "整理", body: body.trim() });
    return "";
  });
  return { rest: rest.replace(/\n{2,}/g, "\n").trim(), drafts };
}

// A font with Chinese glyphs: the Debian package fonts-droid-fallback in the
// Docker image, a system font on a Mac.
const FONT_CANDIDATES = [
  process.env.PDF_FONT,
  "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
  "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
].filter(Boolean) as string[];

function fontPath(): string {
  const found = FONT_CANDIDATES.find((p) => fs.existsSync(p));
  if (!found) throw new Error("no Chinese font for PDF output (set PDF_FONT)");
  return found;
}

/** File name for a draft: its title, minus characters QQ/file systems dislike. */
export function draftFileName(d: Draft): string {
  return `${d.title.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40) || "整理"}.pdf`;
}

/** Render a draft (# headings, - bullets, paragraphs) to a PDF. */
export function renderPdf(d: Draft): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 56, info: { Title: d.title } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.font(fontPath());

    doc.fontSize(20).text(d.title, { align: "center" }).moveDown(1);
    for (const raw of d.body.split("\n")) {
      // Markdown emphasis has no meaning in the PDF; drop the markers.
      const line = raw.replace(/\*\*|__/g, "").trimEnd();
      const heading = line.match(/^(#{1,3})\s+(.*)$/);
      const bullet = line.match(/^(\s*)[-*•]\s+(.*)$/);
      if (!line.trim()) {
        doc.moveDown(0.5);
      } else if (heading) {
        doc.moveDown(0.4).fontSize([16, 14, 12.5][heading[1].length - 1]).text(heading[2]).moveDown(0.2);
      } else if (bullet) {
        const indent = 14 + Math.min(3, Math.floor(bullet[1].length / 2)) * 14;
        doc.fontSize(11).text(`•  ${bullet[2]}`, { indent, lineGap: 2 });
      } else {
        doc.fontSize(11).text(line.trim(), { lineGap: 2 });
      }
    }
    doc.end();
  });
}
