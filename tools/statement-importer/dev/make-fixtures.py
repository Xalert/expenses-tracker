#!/usr/bin/env python3
"""Regenerate the binary statement fixtures (PDFs and the PNG scan) for the statement-importer harness.

Everything here is synthetic. No third-party libraries: the PDFs are written by hand (Courier, WinAnsi, ASCII
text only) and the scans are rasterised with macOS `sips`. Run from anywhere:

    python3 tools/statement-importer/dev/make-fixtures.py
"""
import os
import subprocess
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "fixtures")


def pdf_escape(s: str) -> str:
    return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def write_pdf(path: str, pages: list, size=(612, 792)) -> None:
    """pages: list of ("text", lines, font_size) or ("jpeg", bytes, px_w, px_h)."""
    w, h = size
    objs = []  # index i -> bytes of object i+1

    def add(body: bytes) -> int:
        objs.append(body)
        return len(objs)

    font = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>")
    pages_id = add(b"")  # placeholder
    kids = []
    for page in pages:
        if page[0] == "text":
            _, lines, fs = page
            lead = fs * 1.35
            parts = [f"BT /F1 {fs} Tf {lead:.2f} TL 40 {h - 50} Td".encode()]
            for ln in lines:
                parts.append(f"({pdf_escape(ln)}) Tj T*".encode("latin-1"))
            parts.append(b"ET")
            stream = b"\n".join(parts)
            content = add(b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream")
            res = b"<< /Font << /F1 %d 0 R >> >>" % font
        else:
            _, data, pw, ph = page
            img = add(
                b"<< /Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceRGB "
                b"/BitsPerComponent 8 /Filter /DCTDecode /Length %d >>\nstream\n" % (pw, ph, len(data))
                + data
                + b"\nendstream"
            )
            stream = f"q {w} 0 0 {h} 0 0 cm /Im1 Do Q".encode()
            content = add(b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream")
            res = b"<< /XObject << /Im1 %d 0 R >> >>" % img
        kid = add(
            b"<< /Type /Page /Parent %d 0 R /MediaBox [0 0 %d %d] /Resources %s /Contents %d 0 R >>"
            % (pages_id, w, h, res, content)
        )
        kids.append(kid)
    objs[pages_id - 1] = b"<< /Type /Pages /Kids [%s] /Count %d >>" % (
        b" ".join(b"%d 0 R" % k for k in kids),
        len(kids),
    )
    catalog = add(b"<< /Type /Catalog /Pages %d 0 R >>" % pages_id)
    info = add(b"<< /Title (Synthetic statement fixture) /Producer (make-fixtures.py) >>")

    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for i, body in enumerate(objs, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    for off in offsets:
        out += b"%010d 00000 n \n" % off
    out += b"trailer\n<< /Size %d /Root %d 0 R /Info %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (
        len(objs) + 1,
        catalog,
        info,
        xref,
    )
    with open(path, "wb") as f:
        f.write(out)


def rasterise(lines: list, fmt: str, size=(1100, 1400), fs=17) -> tuple:
    """Render lines to an image via a temporary PDF and `sips`. Returns (bytes, width, height)."""
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "src.pdf")
        dst = os.path.join(tmp, "out." + ("jpg" if fmt == "jpeg" else "png"))
        write_pdf(src, [("text", lines, fs)], size=size)
        subprocess.run(["sips", "-s", "format", fmt, src, "--out", dst], check=True, capture_output=True)
        with open(dst, "rb") as f:
            data = f.read()
        dims = subprocess.run(["sips", "-g", "pixelWidth", "-g", "pixelHeight", dst], check=True, capture_output=True, text=True).stdout
        pw = int(dims.split("pixelWidth:")[1].split()[0])
        ph = int(dims.split("pixelHeight:")[1].split()[0])
        return data, pw, ph


CARD_OCT = [
    "EXAMPLE CARD SERVICES - MONTHLY STATEMENT",
    "Card holder: Ion Popescu",
    "Card: **** **** **** 4417        Currency: EUR",
    "Period: 01/10/2026 - 31/10/2026",
    "",
    "Date        Description                          Amount EUR",
    "----------------------------------------------------------",
    "06/10/2026  UBER *TRIP HELP.UBER.COM                 -14.20",
    "07/10/2026  BOLT.EU/O/2610                            -8.90",
    "12/10/2026  NETFLIX.COM AMSTERDAM                    -13.99",
    "15/10/2026  AMAZON EU SARL REFUND                    +29.99",
    "20/10/2026  UBER *TRIP HELP.UBER.COM                  -9.80",
    "24/10/2026  LIDL DIENSTLEISTUNG                      -18.75",
    "            Neckarsulm DE, card present",
    "----------------------------------------------------------",
    "Opening balance 450.00      Closing balance 414.35",
]

CARD_SEP_SCAN = [
    "EXAMPLE CARD SERVICES - MONTHLY STATEMENT",
    "Card holder: Ion Popescu",
    "Card: **** **** **** 4417        Currency: EUR",
    "Period: 01/09/2026 - 30/09/2026",
    "",
    "Date        Description                          Amount EUR",
    "----------------------------------------------------------",
    "03/09/2026  UBER *TRIP HELP.UBER.COM                 -11.40",
    "18/09/2026  NETFLIX.COM AMSTERDAM                    -13.99",
    "22/09/2026  ALBERT HEIJN 1203 AMSTERDAM              -27.35",
    "----------------------------------------------------------",
    "Opening balance 502.74      Closing balance 450.00",
]

CREDIT_SCAN = [
    "BANCA EXEMPLU SA",
    "Extras card de credit / Credit card statement",
    "Card: **** 9921          Moneda: RON",
    "Perioada: 01.10.2026 - 31.10.2026",
    "",
    "Data        Descriere                              Suma RON",
    "-----------------------------------------------------------",
    "05.10.2026  EMAG.RO MARKETPLACE                      499,99",
    "11.10.2026  KAUFLAND 0921 BUCURESTI                  156,20",
    "19.10.2026  MEGA IMAGE 0412 BUCURESTI                 33,10",
    "26.10.2026  OMV PETROM 0213 PLOIESTI                 250,00",
    "-----------------------------------------------------------",
    "Total de plata: 939,29 RON     Scadenta: 25.11.2026",
]


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    write_pdf(os.path.join(OUT, "card-statement.pdf"), [("text", CARD_OCT, 10)])

    jpg, pw, ph = rasterise(CARD_SEP_SCAN, "jpeg")
    write_pdf(os.path.join(OUT, "scanned-statement.pdf"), [("jpeg", jpg, pw, ph)], size=(pw * 72 // 144, ph * 72 // 144))

    png, _, _ = rasterise(CREDIT_SCAN, "png")
    with open(os.path.join(OUT, "credit-card-scan.png"), "wb") as f:
        f.write(png)
    print("wrote card-statement.pdf, scanned-statement.pdf, credit-card-scan.png")


if __name__ == "__main__":
    main()
