
import PDFDocument from "pdfkit";
import {
  Document,
  Paragraph,
  TextRun,
  HeadingLevel,
  Packer
} from "docx";

// 파일 형식별 정보
const FORMATS = {
  txt: {
    extension: "txt",
    mimeType: "text/plain; charset=utf-8"
  },
  md: {
    extension: "md",
    mimeType: "text/markdown; charset=utf-8"
  },
  html: {
    extension: "html",
    mimeType: "text/html; charset=utf-8"
  },
  json: {
    extension: "json",
    mimeType: "application/json"
  },
  pdf: {
    extension: "pdf",
    mimeType: "application/pdf"
  },
  docx: {
    extension: "docx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  }
};

// 파일명에 사용할 수 없는 문자 제거
function safeFileName(title) {
  return (title || "회의록")
    .replace(/[\\/:*?"<>|]/g, "_")
    .trim()
    .slice(0, 80) || "회의록";
}

// HTML 특수문자 처리
function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (char) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    };
    return entities[char];
  });
}

// TXT 변환
function toTxt(record) {
  return [
    record.title,
    `작성일: ${record.createdAt || ""}`,
    "",
    record.transcript
  ].join("\n");
}

// Markdown 변환
function toMarkdown(record) {
  return [
    `# ${record.title}`,
    "",
    `작성일: ${record.createdAt || ""}`,
    "",
    "## 회의 및 강의 내용",
    "",
    record.transcript
  ].join("\n");
}

// HTML 변환
function toHtml(record) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(record.title)}</title>
</head>
<body>
<h1>${escapeHtml(record.title)}</h1>
<p>작성일: ${escapeHtml(record.createdAt || "")}</p>
<hr>
<h2>회의 및 강의 내용</h2>
<p>${escapeHtml(record.transcript).replace(/\n/g, "<br>")}</p>
</body>
</html>`;
}

// JSON 변환
function toJson(record) {
  return JSON.stringify({
    title: record.title,
    createdAt: record.createdAt || null,
    transcript: record.transcript
  }, null, 2);
}

// PDF 변환
function toPdf(record) {
  return new Promise((resolve, reject) => {
    const fontPath = process.env.PDF_FONT_PATH;

    if (!fontPath) {
      return reject(
        new Error("PDF_FONT_PATH에 한글 폰트 경로를 설정해야 합니다.")
      );
    }

    const doc = new PDFDocument({
      size: "A4",
      margins: {
        top: 50,
        bottom: 50,
        left: 50,
        right: 50
      }
    });

    const chunks = [];

    doc.on("data", chunk => chunks.push(chunk));
    doc.on("error", reject);

    doc.on("end", () => {
      resolve(Buffer.concat(chunks));
    });

    doc.font(fontPath);

    doc.fontSize(20)
      .text(record.title, { align: "center" });

    doc.moveDown();
    doc.fontSize(10)
      .text(`작성일: ${record.createdAt || ""}`);

    doc.moveDown();
    doc.fontSize(14)
      .text("회의 및 강의 내용");

    doc.moveDown();
    doc.fontSize(11)
      .text(record.transcript, {
        lineGap: 5
      });

    doc.end();
  });
}

// DOCX 변환
async function toDocx(record) {
  const paragraphs = [
    new Paragraph({
      text: record.title,
      heading: HeadingLevel.HEADING_1
    }),
    new Paragraph({
      children: [
        new TextRun(
          `작성일: ${record.createdAt || ""}`
        )
      ]
    }),
    new Paragraph({
      text: "회의 및 강의 내용",
      heading: HeadingLevel.HEADING_2
    })
  ];

  record.transcript.split("\n").forEach(line => {
    paragraphs.push(
      new Paragraph({
        children: [new TextRun(line || " ")]
      })
    );
  });

  const document = new Document({
    sections: [{
      properties: {},
      children: paragraphs
    }]
  });

  return await Packer.toBuffer(document);
}

// 메인 파일 내보내기 함수
export async function exportMeeting(record, format) {
  if (
    !record ||
    typeof record.title !== "string" ||
    typeof record.transcript !== "string" ||
    !record.title.trim() ||
    !record.transcript.trim()
  ) {
    throw new Error("올바른 회의록 데이터가 필요합니다.");
  }

  const selectedFormat = format.toLowerCase();

  if (!FORMATS[selectedFormat]) {
    throw new Error("지원하지 않는 파일 형식입니다.");
  }

  let fileContent;

  switch (selectedFormat) {
    case "txt":
      fileContent = Buffer.from(toTxt(record), "utf-8");
      break;

    case "md":
      fileContent = Buffer.from(toMarkdown(record), "utf-8");
      break;

    case "html":
      fileContent = Buffer.from(toHtml(record), "utf-8");
      break;

    case "json":
      fileContent = Buffer.from(toJson(record), "utf-8");
      break;

    case "pdf":
      fileContent = await toPdf(record);
      break;

    case "docx":
      fileContent = await toDocx(record);
      break;
  }

  return {
    success: true,
    fileName:
      `${safeFileName(record.title)}.${FORMATS[selectedFormat].extension}`,
    mimeType: FORMATS[selectedFormat].mimeType,
    fileContent
  };
}