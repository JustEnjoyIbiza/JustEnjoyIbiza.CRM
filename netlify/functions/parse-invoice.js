// Netlify Function: Reads an invoice file (PDF or image) and extracts
// supplier, date, total, VAT, category, description using Claude vision.
// Anthropic API key is stored as ANTHROPIC_API_KEY in Netlify env vars.

exports.handler = async function (event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  try {
    const { fileUrl, fileName, direction } = JSON.parse(event.body || "{}");
    if (!fileUrl) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing fileUrl" }) };
    }

    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    if (!ANTHROPIC_API_KEY) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: "Parser not configured (ANTHROPIC_API_KEY missing in Netlify env)" })
      };
    }

    // ---- Download the file from storage ----
    const fileResp = await fetch(fileUrl);
    if (!fileResp.ok) {
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: "Could not download file from storage", status: fileResp.status })
      };
    }
    const arrayBuf = await fileResp.arrayBuffer();
    const base64 = Buffer.from(arrayBuf).toString("base64");

    // ---- Determine MIME type ----
    let mimeType = (fileResp.headers.get("content-type") || "").split(";")[0].trim();
    const ext = (fileName || fileUrl || "").toLowerCase().split(".").pop();
    if (!mimeType || mimeType === "application/octet-stream") {
      if (ext === "pdf") mimeType = "application/pdf";
      else if (ext === "png") mimeType = "image/png";
      else if (ext === "jpg" || ext === "jpeg") mimeType = "image/jpeg";
      else if (ext === "heic") mimeType = "image/heic";
      else if (ext === "webp") mimeType = "image/webp";
    }
    // HEIC isn't supported by Claude vision — bail with a clear message
    if (mimeType === "image/heic") {
      return {
        statusCode: 415,
        headers,
        body: JSON.stringify({
          error: "HEIC photos can't be read directly. Please convert to JPEG (iPhone: Settings → Camera → Formats → Most Compatible)."
        })
      };
    }

    const isPdf = mimeType === "application/pdf";
    const isImg = mimeType.startsWith("image/");
    if (!isPdf && !isImg) {
      return {
        statusCode: 415,
        headers,
        body: JSON.stringify({ error: "Unsupported file type: " + mimeType })
      };
    }

    // ---- Build prompt ----
    const dirLabel =
      direction === "in"
        ? "RECEIVED (supplier/vendor invoice the user paid)"
        : direction === "out"
        ? "SENT (invoice the user issued to a client)"
        : "unknown direction";

    // The USER's own company identifiers. NEVER use these as the supplier/client name.
    // (Used in the prompt so Claude knows to ignore the issuer block on SENT invoices.)
    const USER_COMPANY_HINTS =
      "- 'Just Enjoy Ibiza'\n" +
      "- 'Just Enjoy Ibiza S.L.' / 'Just Enjoy Ibiza SL'\n" +
      "- NIF / CIF 'B56880875'\n" +
      "- Owner name 'Alin Letca' / 'Alin Stefan Letca'\n" +
      "- Address 'Avenida Sant Jordi 48-52, 07817 Ibiza'";

    const sentSpecificRules =
      direction === "out"
        ? "\nCRITICAL — THIS IS A SENT INVOICE (the user issued it). The 'supplier' field must contain the CLIENT (the recipient), NOT the issuer.\n" +
          "The issuer (which you MUST IGNORE) is the user's own company. The user's company will appear at the top of the invoice as one of the following:\n" +
          USER_COMPANY_HINTS + "\n" +
          "Look for the CLIENT inside a block labeled 'Cliente', 'Datos del cliente', 'Receptor', 'Factura para', 'Bill To', 'A:', or similar. The client is often the SECOND name on the invoice, in a smaller box, with their own NIF/DNI/passport.\n" +
          "If you can only see the user's own company and cannot find a separate client name, return an EMPTY STRING for 'supplier' and set confidence to 'low'. NEVER, under any circumstances, return 'Just Enjoy Ibiza' or any variant of it as the supplier.\n"
        : "\nThis is a RECEIVED invoice (the user paid it). The 'supplier' is the vendor/issuer who sent this invoice TO the user. Use the trading name (top of the document, usually largest text).\n";

    const prompt =
      "You are reading a Spanish invoice (factura). The user marked this as " + dirLabel + ".\n" +
      sentSpecificRules + "\n" +
      "Extract the fields below and return ONLY a JSON object (no preamble, no markdown fences, no commentary):\n\n" +
      "{\n" +
      '  "supplier": "Company or person the invoice is from (if received) or to (if sent). See the CRITICAL rules above for sent invoices. Empty string if unclear.",\n' +
      '  "date": "YYYY-MM-DD of the invoice date (fecha factura). If only month+year is visible, use the first day of that month. Empty string if not found.",\n' +
      '  "total": number,\n' +
      '  "vat": number,\n' +
      '  "net": number,\n' +
      '  "category": "one of: fuel, maintenance, restaurant, marketing, charter, transfer, other",\n' +
      '  "description": "Short description of what was billed for. Max 6 words.",\n' +
      '  "confidence": "high | medium | low"\n' +
      "}\n\n" +
      "Rules:\n" +
      "- All money values in EUR, no currency symbol, no thousand separators, dot for decimals (e.g. 1234.56).\n" +
      "- total = TOTAL FACTURA / IMPORTE TOTAL (the amount due, VAT included).\n" +
      "- vat = sum of all IVA / cuota IVA lines. Use 0 if invoice is VAT-exempt or shows no VAT.\n" +
      "- net = BASE IMPONIBLE (subtotal before VAT). Should equal total − vat. Compute it if not printed.\n" +
      "- Category: pick the closest match. Fuel for gasolina/diesel/marina fuel pump receipts. Maintenance for boat repairs, parts, mechanical, cleaning, antifoul, etc. Restaurant for any food/drink/catering. Marketing for ads, agencies, photo/video. Charter for boat rental income or paying another operator for a boat. Transfer for taxi/private transfer/car rental. Other only if nothing else fits.\n" +
      "- If the document is unreadable, blurry, or not actually an invoice, return all fields empty/zero with confidence \"low\".\n" +
      "- Return only the JSON. Nothing before or after.";

    // ---- Build Anthropic message content ----
    const fileBlock = isPdf
      ? {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: base64 }
        }
      : {
          type: "image",
          source: { type: "base64", media_type: mimeType, data: base64 }
        };

    const messageBody = {
      model: "claude-sonnet-4-5",
      max_tokens: 700,
      messages: [
        {
          role: "user",
          content: [fileBlock, { type: "text", text: prompt }]
        }
      ]
    };

    // ---- Call Anthropic ----
    const anthropicResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify(messageBody)
    });

    if (!anthropicResp.ok) {
      const errText = await anthropicResp.text();
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({
          error: "Claude API error (HTTP " + anthropicResp.status + ")",
          details: errText.substring(0, 500)
        })
      };
    }

    const claudeJson = await anthropicResp.json();
    const text =
      (claudeJson.content && claudeJson.content[0] && claudeJson.content[0].text) || "";

    // ---- Parse JSON out of the response ----
    let parsed = null;
    try {
      const trimmed = text.trim().replace(/^```json\s*/i, "").replace(/```\s*$/i, "");
      const m = trimmed.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : JSON.parse(trimmed);
    } catch (e) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ error: "Model returned non-JSON", raw: text.substring(0, 400) })
      };
    }

    // ---- Sanity / coerce numbers ----
    const num = function (x) {
      if (x === "" || x == null) return 0;
      const n = typeof x === "number" ? x : parseFloat(String(x).replace(",", "."));
      return isFinite(n) ? n : 0;
    };
    parsed.total = num(parsed.total);
    parsed.vat = num(parsed.vat);
    parsed.net = num(parsed.net);
    // If net obviously off, recompute
    if (parsed.total > 0 && Math.abs(parsed.net - (parsed.total - parsed.vat)) > 0.05) {
      parsed.net = +(parsed.total - parsed.vat).toFixed(2);
    }

    // ---- Defensive guard: on SENT invoices, never return the user's own company ----
    // The AI sometimes confuses the issuer (Just Enjoy Ibiza, written large at the top)
    // with the client. If that happens, blank the supplier field so the user fills it in
    // manually rather than getting a wrong name silently saved.
    if (direction === "out" && parsed.supplier) {
      const s = String(parsed.supplier).toLowerCase();
      const ownCompanyPatterns = [
        "just enjoy ibiza",
        "justenjoyibiza",
        "b56880875",
        "alin letca",
        "alin stefan letca"
      ];
      const looksLikeOwnCompany = ownCompanyPatterns.some(function (p) {
        return s.indexOf(p) !== -1;
      });
      if (looksLikeOwnCompany) {
        parsed.supplier = "";
        parsed.confidence = "low";
        parsed._guard = "stripped_own_company_from_sent_invoice";
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, data: parsed })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message || "Unknown error" })
    };
  }
};
