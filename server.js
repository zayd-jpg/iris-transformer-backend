// server.js – Iris backend with mm-accurate pupil

require("dotenv").config();
const express = require("express");
const multer = require("multer");
const OpenAI = require("openai");
const sharp = require("sharp");
const fs = require("fs");

const app = express();
const upload = multer({ dest: "uploads/" });

// CORS so Odoo (another domain) can call this
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*"); // you can restrict to your domain later
  res.header("Access-Control-Allow-Headers", "Content-Type");
  next();
});

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

if (!process.env.OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY is not set in environment");
}

// Helper: build the prompt for OpenAI
function buildPrompt(pupilMode, pupilMm) {
  const baseInstruction = `
You are editing an eye photograph into a clean iris preview.

Goal:
- Output a single, perfectly centered CIRCULAR iris on a pure black (#000000) background.
- No eyelids, eyelashes, skin, sclera, or surrounding face at all.
- The iris should fill most of the frame but keep a thin margin of pure black background.
- Preserve detailed iris texture (crypts, striations, radial lines).
- Keep a crisp limbal ring (dark outer border of the iris).
- Remove or suppress all reflections, catchlights, and glints. Do NOT add new reflections.
- No text, no logos, no borders.

Geometry:
- The iris must be perfectly circular and exactly centered in the square image.
- Background must be pure #000000 with no gradient, no vignette.
`.trim();

  const pupilNatural = `
Pupil:
- Pupil is circular and pure black.
- Use a natural-looking pupil size for normal indoor lighting.
`.trim();

  const pupilFixed = `
Pupil:
- Pupil is circular and pure black.
- The iris corresponds to 12.5 mm in real life.
- The pupil diameter in the final image should correspond to approximately ${pupilMm} mm in real life.
- This means the pupil diameter is about ( ${pupilMm} / 12.5 ) of the iris diameter.
- Keep it anatomically realistic, exactly centered.
`.trim();

  return (
    baseInstruction +
    "\n\n" +
    (pupilMode === "fixed" ? pupilFixed : pupilNatural) +
    "\n\nNote: Do not add any extra shapes or markings. Only the iris and the pupil on black."
  );
}

// POST /api/iris
app.post("/api/iris", upload.single("image"), async (req, res) => {
  const filePath = req.file?.path;
  const pupilMode = req.body?.pupil_mode || "natural"; // "natural" or "fixed"
  const pupilMmStr = req.body?.pupil_mm; // e.g. "3.5"

  if (!filePath) {
    return res.status(400).send("No image uploaded");
  }

  // Square output size in pixels
  const IMAGE_SIZE = 2048;

  try {
    let pupilMm = null;
    if (pupilMode === "fixed") {
      pupilMm = parseFloat(pupilMmStr);
      if (!pupilMm || pupilMm <= 0) {
        return res.status(400).send("Invalid pupil_mm value");
      }
    }

    const prompt = buildPrompt(pupilMode, pupilMm);
    const imageFile = fs.createReadStream(filePath);

    // Decide which method to use on the client (edit preferred, fallback to generate)
    const hasEdit =
      client.images && typeof client.images.edit === "function";

    let response;
    if (hasEdit) {
      // Proper image edit with your uploaded eye photo
      response = await client.images.edit({
        model: "gpt-image-1",
        image: imageFile,
        prompt,
        size: `${IMAGE_SIZE}x${IMAGE_SIZE}`,
        response_format: "b64_json",
      });
    } else {
      // Fallback: generate from prompt only (no image input).
      // Not ideal, but avoids crashes if the SDK changes.
      response = await client.images.generate({
        model: "gpt-image-1",
        prompt,
        size: `${IMAGE_SIZE}x${IMAGE_SIZE}`,
        response_format: "b64_json",
      });
    }

    const b64 = response.data?.[0]?.b64_json;
    if (!b64) throw new Error("No image returned from OpenAI");

    const irisBuffer = Buffer.from(b64, "base64");
    let outputBuffer = irisBuffer;

    // 2) If a fixed mm pupil was requested, overlay a precise black circle
    if (pupilMode === "fixed" && pupilMm) {
      // Assume iris circle occupies ~90% of the full width (small black margin)
      const irisDiameterPx = IMAGE_SIZE * 0.9;
      const pupilFraction = pupilMm / 12.5; // because iris is 12.5 mm in real life
      const pupilDiameterPx = irisDiameterPx * pupilFraction;
      const pupilRadiusPx = pupilDiameterPx / 2;

      const center = IMAGE_SIZE / 2;

      const svg = `
        <svg width="${IMAGE_SIZE}" height="${IMAGE_SIZE}" xmlns="http://www.w3.org/2000/svg">
          <rect width="100%" height="100%" fill="transparent"/>
          <circle cx="${center}" cy="${center}" r="${pupilRadiusPx}" fill="black" />
        </svg>
      `;

      outputBuffer = await sharp(irisBuffer)
        .composite([
          {
            input: Buffer.from(svg),
            blend: "over",
          },
        ])
        .png()
        .toBuffer();
    }

    res.setHeader("Content-Type", "image/png");
    res.send(outputBuffer);
  } catch (err) {
    console.error("❌ Error in /api/iris:", err?.response?.data || err.message || err);
    res.status(500).send(err.message || "Error processing iris image");
  } finally {
    if (filePath) fs.unlink(filePath, () => {});
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Iris backend running on http://localhost:${PORT}`);
});
