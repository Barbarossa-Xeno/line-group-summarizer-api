import { http } from '@google-cloud/functions-framework';
import { GoogleGenAI } from '@google/genai';
import { validateSignature, LineBotClient } from "@line/bot-sdk";

const client = LineBotClient.fromChannelAccessToken({
		channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN
	});

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

  // LINEの署名を検証
  const isValid = validateSignature(req.rawBody, process.env.LINE_CHANNEL_SECRET, req.headers['x-line-signature']);

  // 署名が有効でない場合（LINE外からのアクセス）は拒否
	if (!isValid) {
		return res.status(401).send("Unauthorized");
	}

	// TODO: イベント処理
	for (const event of req.body.events) {
		console.log(event);
	}

	// LINEのサーバー側には200だけ送って終わらせない
	res.status(200).send("OK");

	// 本処理
  // try {
  //   const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  //   const response = await ai.models.generateContent({
  //     model: 'gemini-3.5-flash',
  //     contents: 'あなたのできることを1文で簡単に教えて。'
		// });

  //   return res.send(response.text);
  // }
  // catch (error) {
  //   console.error(error);
  //   return res.status(500).send(error);
  // }
});
