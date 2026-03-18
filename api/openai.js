export async function callOpenAI(apiKey, requestBody) {
  if (!apiKey) {
    throw new Error("Server misconfiguration: missing OpenAI key");
  }

 fetch("http://localhost:4000/api/openai", {
  method: "POST",
  headers: {
    "Content-Type": "application/json"
  },
  body: JSON.stringify(data)
})

  const data = await response.json();
  
  return {
    status: response.status,
    data: data
  };
}