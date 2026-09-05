import { http } from '@google-cloud/functions-framework';
import { GoogleGenAI } from '@google/genai';
import * as line from "@line/bot-sdk";

// エントリーポイント
http('main', async (req, res) => {
  res.set('Content-Type', 'text/plain');

  // `/test` のパスパラメータを使って接続確認する場合は、すぐレスポンス終える
  if (req.path.split('/').at(1).toLowerCase() === 'test') {
    return res.send(`
    Connection succeed.
    [${new Date().toLocaleString('ja-JP')}]
    `);
	}

  const isValid = line.validateSignature(req.rawBody, process.env.LINE_API_SECRET, req.headers['x-line-signature']);

	if (!isValid) {
		return res.status(401).send("Unauthorized");
	}

	for (const event of req.body.events) {
		console.log(event);
	}

	// 200だけ送って終わらせない
	res.status(200).send("OK");

	//
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: 'あなたのできることを1文で簡単に教えて。'
    });

    res.send(response.text);
  }
  catch (error) {
    console.error(error);
    res.status(500).send(error);
  }
});
