import { describe, expect, it } from "vitest";
import { detectDelimiter, escapeFormula, parseCsv, toCsv, unescapeFormula } from "@/lib/csv";

const cells = (text: string, opts?: Parameters<typeof parseCsv>[1]) => parseCsv(text, opts).records.map((r) => r.cells);
const lines = (text: string) => parseCsv(text).records.map((r) => r.line);

describe("parseCsv", () => {
  it("reads plain rows with LF, CRLF and lone CR line endings", () => {
    expect(cells("a,b\n1,2\n")).toEqual([["a", "b"], ["1", "2"]]);
    expect(cells("a,b\r\n1,2\r\n")).toEqual([["a", "b"], ["1", "2"]]);
    expect(cells("a,b\r1,2")).toEqual([["a", "b"], ["1", "2"]]);
    expect(cells("a,b\r\n1,2\n3,4\r5,6")).toEqual([["a", "b"], ["1", "2"], ["3", "4"], ["5", "6"]]);
  });

  it("strips a UTF-8 BOM", () => {
    expect(cells("﻿date,type\n2026-01-01,expense")).toEqual([["date", "type"], ["2026-01-01", "expense"]]);
  });

  it("keeps empty cells, including a trailing one", () => {
    expect(cells("a,,c\n,,\nx,")).toEqual([["a", "", "c"], ["", "", ""], ["x", ""]]);
  });

  it("handles quoted cells with delimiters, doubled quotes and embedded newlines", () => {
    const text = 'name,note\r\n"Smith, J","He said ""hi"""\r\n"multi\r\nline\nnote",x\r\n';
    expect(cells(text)).toEqual([
      ["name", "note"],
      ["Smith, J", 'He said "hi"'],
      ["multi\nline\nnote", "x"],
    ]);
    expect(cells('"",x\n"",""')).toEqual([["", "x"], ["", ""]]);
  });

  it("reports the physical line each record starts on, across embedded newlines and blank lines", () => {
    const text = 'h1,h2\n"a\nb\nc",1\n\nnext,2\r\n\r\nlast,3';
    expect(lines(text)).toEqual([1, 2, 6, 8]);
    expect(cells(text)[1]).toEqual(["a\nb\nc", "1"]);
  });

  it("skips blank lines", () => {
    expect(cells("a\n\n\nb\n\n")).toEqual([["a"], ["b"]]);
  });

  it("keeps a quote in the middle of an unquoted cell literally", () => {
    expect(cells('a,5" screen\n')).toEqual([["a", '5" screen']]);
  });

  it("reports an unterminated quoted cell with the line it starts on", () => {
    const r = parseCsv('a,b\n1,"never closed\n2,3\n');
    expect(r.errors).toEqual([{ line: 2, message: expect.stringContaining("never closed") }]);
  });

  it("reports text after a closing quote", () => {
    const r = parseCsv('a,b\n"x"y,2\n');
    expect(r.errors[0].line).toBe(2);
    expect(r.errors[0].message).toMatch(/closing quote/);
  });

  it("detects , ; and tab from the header line, ignoring delimiters inside quotes", () => {
    expect(detectDelimiter("date;type;wallet\n1,2,3,4,5")).toBe(";");
    expect(detectDelimiter("date\ttype\twallet")).toBe("\t");
    expect(detectDelimiter('"a;b;c;d",x,y')).toBe(",");
    expect(detectDelimiter("single")).toBe(",");
    expect(cells("a;b\n1,5;2,5")).toEqual([["a", "b"], ["1,5", "2,5"]]);
    expect(cells("a\tb\n\"x\ty\"\tz")).toEqual([["a", "b"], ["x\ty", "z"]]);
  });

  it("stops after maxRecords + 1 records", () => {
    const text = Array.from({ length: 100 }, (_, i) => `${i}`).join("\n");
    expect(parseCsv(text, { maxRecords: 10 }).records).toHaveLength(11);
  });
});

describe("toCsv", () => {
  it("writes a BOM, CRLF line endings and RFC 4180 quoting", () => {
    const out = toCsv([
      ["a", "b"],
      ["x,y", 'say "hi"'],
      ["line\nbreak", "plain"],
    ]);
    expect(out).toBe('﻿a,b\r\n"x,y","say ""hi"""\r\n"line\nbreak",plain\r\n');
    expect(toCsv([["a"]], { bom: false })).toBe("a\r\n");
    expect(toCsv([["a;b", "c"]], { delimiter: ";", bom: false })).toBe('"a;b";c\r\n');
  });

  it("round-trips arbitrary cells through parseCsv", () => {
    const rows = [
      ["date", "note", "x"],
      ["2026-01-01", 'quotes " and ""doubled""', "a,b;c\td"],
      ["", "multi\nline\n\nwith blank", "trailing\n"],
      ["über €", "日本円", "'"],
    ];
    expect(parseCsv(toCsv(rows)).records.map((r) => r.cells)).toEqual(rows);
    const semi = toCsv(rows, { delimiter: ";" });
    expect(parseCsv(semi).records.map((r) => r.cells)).toEqual(rows);
  });
});

describe("formula injection guard", () => {
  it("prefixes cells a spreadsheet would evaluate", () => {
    for (const v of ["=SUM(A1:A9)", "+1", "-5 refund", "@cmd", "\tx", "\rx"]) expect(escapeFormula(v)).toBe(`'${v}`);
    expect(escapeFormula("Groceries")).toBe("Groceries");
    expect(escapeFormula("")).toBe("");
    expect(escapeFormula("a=b")).toBe("a=b");
  });

  it("also prefixes a value that already starts with ' so removal is unambiguous", () => {
    expect(escapeFormula("'quoted")).toBe("''quoted");
    expect(escapeFormula("'=not a formula")).toBe("''=not a formula");
  });

  it("removes exactly one protecting quote on import", () => {
    expect(unescapeFormula("'=SUM(A1)")).toBe("=SUM(A1)");
    expect(unescapeFormula("'-5 refund")).toBe("-5 refund");
    expect(unescapeFormula("''quoted")).toBe("'quoted");
    // A hand-written leading ' that protects nothing is kept.
    expect(unescapeFormula("'quoted")).toBe("'quoted");
    expect(unescapeFormula("'")).toBe("'");
  });

  it("round-trips every value exactly", () => {
    for (const v of ["=1+1", "-", "-5", "'", "''", "'-x", "'=x", "''=x", "plain", "@", "+", "a'b", "'a"]) {
      expect(unescapeFormula(escapeFormula(v))).toBe(v);
    }
  });
});
