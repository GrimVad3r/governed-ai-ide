// ============================================================
// ContentHasher.ts — SHA-256 Hashing for Spatial Independence
// ============================================================
// Purpose: Generate content hashes that remain valid even when
// line numbers shift (spatial independence). A hash identifies
// a block of code by its content, not its position.

import * as crypto from "crypto";

export class ContentHasher {
  /**
   * Hash an arbitrary string (code block, file contents, etc.)
   * Returns "sha256:<hex>" prefix format for easy identification.
   */
  static hash(content: string): string {
    const digest = crypto
      .createHash("sha256")
      .update(content, "utf8")
      .digest("hex");
    return `sha256:${digest}`;
  }

  /**
   * Hash a specific line range from file contents.
   * Lines are 1-indexed and inclusive on both ends.
   */
  static hashLines(
    fileContents: string,
    start_line: number,
    end_line: number
  ): string {
    const lines = fileContents.split("\n");
    // Clamp to valid range
    const start = Math.max(0, start_line - 1);
    const end = Math.min(lines.length, end_line);
    const block = lines.slice(start, end).join("\n");
    return ContentHasher.hash(block);
  }

  /**
   * Hash entire file contents — used for concurrency/optimistic locking.
   */
  static hashFile(fileContents: string): string {
    return ContentHasher.hash(fileContents);
  }

  /**
   * Compare two hashes in constant time (timing-safe).
   */
  static compare(hashA: string, hashB: string): boolean {
    const a = Buffer.from(hashA.replace("sha256:", ""), "hex");
    const b = Buffer.from(hashB.replace("sha256:", ""), "hex");
    if (a.length !== b.length) return false;
    try {
      return crypto.timingSafeEqual(a, b);
    } catch {
      return hashA === hashB;
    }
  }

  /**
   * Detect which line ranges changed between two versions of a file.
   * Returns array of {startLine, endLine, hash} for each changed block.
   */
  static diffLineRanges(
    oldContent: string,
    newContent: string
  ): Array<{ start_line: number; end_line: number; content_hash: string }> {
    const oldLines = oldContent.split("\n");
    const newLines = newContent.split("\n");
    const ranges: Array<{
      start_line: number;
      end_line: number;
      content_hash: string;
    }> = [];

    let inDiff = false;
    let diffStart = 0;

    const maxLen = Math.max(oldLines.length, newLines.length);

    for (let i = 0; i < maxLen; i++) {
      const oldLine = oldLines[i] ?? "";
      const newLine = newLines[i] ?? "";
      const changed = oldLine !== newLine;

      if (changed && !inDiff) {
        inDiff = true;
        diffStart = i;
      } else if (!changed && inDiff) {
        // Close the current diff block
        const block = newLines.slice(diffStart, i).join("\n");
        ranges.push({
          start_line: diffStart + 1,
          end_line: i,
          content_hash: ContentHasher.hash(block),
        });
        inDiff = false;
      }
    }

    // Close any open block at end of file
    if (inDiff) {
      const block = newLines.slice(diffStart).join("\n");
      ranges.push({
        start_line: diffStart + 1,
        end_line: newLines.length,
        content_hash: ContentHasher.hash(block),
      });
    }

    // If nothing changed, hash entire new file as single range
    if (ranges.length === 0) {
      ranges.push({
        start_line: 1,
        end_line: newLines.length,
        content_hash: ContentHasher.hashFile(newContent),
      });
    }

    return ranges;
  }
}