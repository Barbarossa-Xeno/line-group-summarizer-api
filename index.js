import { http } from '@google-cloud/functions-framework';
import { GoogleGenAI } from '@google/genai';
import * as line from "@line/bot-sdk";

// エントリーポイント
http('main', async (req, res) => {
  res.set('Content-Type', 'text/plain');

  // `/test` のパスパラメータを使って接続確認
  if (req.path.split('/').at(1).toLowerCase() === 'test') {
    return res.send(`
    Connection succeed.
    [${new Date().toLocaleString('ja-JP')}]
    `);
  }

  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: 'あなたのできることを簡単に教えて。'
    });

    res.send(response.text);
  }
  catch (error) {
    console.error(error);
    res.status(500).send(error);
  }
});

// LINE Message API の Webhook
http('webhook', (req, res) => {
	line.middleware({ channelSecret: process.env.LINE_API_SECRET });
	return res.status(200).end();
});
