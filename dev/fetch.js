const axios = require("axios");

async function fetch(url, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const headers = options.headers || {};
  const body = options.body;

  try {
    const response = await axios({
      url,
      method,
      headers,
      data: body,
      responseType: options.responseType || "text",
      validateStatus: () => true 
    });

    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      statusText: response.statusText,
      headers: {
        get: (key) => response.headers[key.toLowerCase()]
      },
      text: async () => (typeof response.data === "string" ? response.data : JSON.stringify(response.data)),
      json: async () => {
        if (typeof response.data === "object") return response.data;
        try {
          return JSON.parse(response.data);
        } catch {
          return {};
        }
      },
      blob: async () => response.data,
    };
  } catch (err) {
    throw new Error(`Fetch failed: ${err.message}`);
  }
}

module.exports = fetch;
