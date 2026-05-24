// Netlify Function: Securely sends emails via Resend API
// API key is stored in Netlify environment variables (NEVER in client code)

exports.handler = async function(event, context) {
  // CORS headers (allows the CRM to call this function)
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
  };

  // Handle CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  // Only allow POST
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Method not allowed" })
    };
  }

  try {
    const { to, subject, html } = JSON.parse(event.body || "{}");

    // Validation
    if (!to || !subject || !html) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Missing required fields: to, subject, html" })
      };
    }

    // Get API key from Netlify environment variables (set in Netlify dashboard)
    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    if (!RESEND_API_KEY) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: "Email service not configured (missing API key)" })
      };
    }

    // Forward request to Resend
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: "Just Enjoy Ibiza <info@justenjoyibiza.com>",
        to: [to],
        bcc: ["info@justenjoyibiza.com"],
        reply_to: "info@justenjoyibiza.com",
        subject: subject,
        html: html
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return {
        statusCode: response.status,
        headers,
        body: JSON.stringify({ error: data.message || "Email send failed", details: data })
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, id: data.id })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message || "Unknown error" })
    };
  }
};
