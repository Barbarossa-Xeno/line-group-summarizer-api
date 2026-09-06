import { http } from '@google-cloud/functions-framework';
import { Firestore } from "@google-cloud/firestore"
import { GoogleGenAI } from '@google/genai';
import { validateSignature, LineBotClient } from "@line/bot-sdk";

// LINEクライアント
const client = LineBotClient.fromChannelAccessToken({
		channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN
	});

// プロジェクトのデフォルトFirestoreクライアント
const db = new Firestore();

// Google AIクライアント
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// エントリーポイント
http('main', async (req, res) => {
  res.set('Content-Type', 'text/plain');

  // `/test` のパスパラメータを使って接続確認する場合は、すぐレスポンス終える
  if (req.path?.startsWith('/test')) {
    return res.send(`
    Connection succeed.
    [${new Date().toLocaleString('ja-JP')}]
    `);
	}

  /** LINEの署名を検証 */
  const isValid = validateSignature(req.rawBody, process.env.LINE_CHANNEL_SECRET, req.headers['x-line-signature']);

  // 署名が有効でない場合（LINE外からのアクセス）は拒否
	if (!isValid) {
		return res.status(401).send("Unauthorized");
	}

	// LINEのサーバー側には200だけ送って終わらせない
	res.status(200).send("OK");

	// IIFE で非同期処理（待機しない）
	(async () => {
		// メイン処理：イベントごとにループ
		// もしエラーが出ればそのタイミングで終了
		try {
			for (const event of req.body.events) {

				// 1つのイベントごとにもエラーハンドリング
				try {

					// 誰かから送信されたメッセージのイベント出ない場合スキップ
					if (event.type !== "message" || event.message.type !== "text") {
						continue;
					}

					console.info(JSON.stringify(event));

					// メッセージのDB追加
					await addMessageToDb(event);

					// 自分がメンションされていない場合は次に進む
					// メンションそのものが無い場合でもスキップ
					if (event.message?.mention?.some((m) => m.isSelf === false)) {
						continue;
					}

					// 要約判定して必要なければスキップ
					// TODO: トークンの使用量が多ければ固定メッセージに変える
					if (!await checkSummarization(event.message.text)) {
						continue;
					}

					// TODO: 要約したのを送信

				} catch (eventError) {
					console.error('[BG] Error in processing a event:', eventError);

					// TODO: エラーをLINEに送信

				}
			}

			console.log('[BG] All events processed.');
		} catch (error) {
			console.error('[BG] Fatal error in main process loop: ', error);
		}
	})();

	// 本処理
  // try {
  //   const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  //   const response = await ai.models.generateContent({
  //     model: 'gemini-3.6-flash',
  //     contents: 'あなたのできることを1文で簡単に教えて。'
		// });

  //   return res.send(response.text);
  // }
  // catch (error) {
  //   console.error(error);
  //   return res.status(500).send(error);
  // }
});

/**
 * Firestore DBにLINEで送信されたメッセージを追加する
 * 失敗した場合例外を投げる
 * @param {{ source: { userId: string?, groupId: string?, roomId: string? }, message: { id: string, text: string } }} event
 */
async function addMessageToDb(event) {
	// グループやルームでも userId が付与されてくることがあるので
	// コレクションとして保存するときは groupId や roomId をキーとして優先するようにこの順番
	const keyId = event.source.groupId || event.source.roomId || event.source.userId;

	try {
		await db.collection(keyId).add({
			userId: event.source.userId,
			messageId: event.message.id,
			message: event.message.text
		});

		console.log(`User message added ${event.message.id}`);
	} catch (error) {
		// 呼び出し元で分かりやすくするためにエラーをラップする
		throw new Error(`Error adding user message (${event.message.id}): ${error}`);
	}
}

/**
 * ボットをメンションしたメッセージが要約を求めているものかどうかAIで確かめる
 * 失敗した場合例外を投げる
 * @param {string} text
 * @returns
 */
async function checkSummarization(text) {
	try {
		const response = await ai.models.generateContent({
			model: 'gemini-3.5-flash-lite',
			contents: `あなたは「@まとめ丸」とします。次のメッセージが自分に対して「メッセージの要約」を要求しているものであると判断できる場合、「Y」とだけ返答してください。そうでない場合「N」とだけ返答してください。それ以外の返答はしないようにしてください。
			---
			${text}
			---`
		});

		if (response.text === 'Y') {
			return true;
		} else if (response.text === 'N') {
			return false;
		} else {
			throw new Error('AI generated unexpected response');
		}
	} catch (error) {
		throw new Error(`Error checking summarization: ${error}`);
	}
}
