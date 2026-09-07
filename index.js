import { http } from '@google-cloud/functions-framework';
import { Firestore, FieldValue, Timestamp } from "@google-cloud/firestore"
import { field } from '@google-cloud/firestore/pipelines';
import { GoogleGenAI } from '@google/genai';
import { validateSignature, LineBotClient } from "@line/bot-sdk";

// LINEクライアント
const client = LineBotClient.fromChannelAccessToken({
	channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN
});

// プロジェクトのデフォルトFirestoreクライアント
const db = new Firestore({ databaseId: "line-group-summarizer-api-db" });

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
					if (event.message?.mention?.mentionees?.some((m) => m.isSelf === false)) {
						continue;
					}

					// 要約判定して必要なければスキップ
					// TODO: トークンの使用量が多ければ固定メッセージに変える
					// TODO: 今までのサマリーを表示する機能があってもいいかも
					if (!await checkSummarization(event.message.text)) {
						continue;
					}

					// 要約
					const summary = await summarize(event);

					if (!summary) {
						continue;
					}

					// LINEに送信する
					await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: "text", text: summary }] });
				} catch (eventError) {
					console.error('[BG] Error in processing a event:', eventError);

					// エラーをLINEに送信
					// FIXME: 今エラー文直送りなのでUXが悪い
					await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: "text", text: `[BG] Error in processing a event: ${eventError.message}` }] });
				}
			}

			console.log('[BG] All events processed.');
		} catch (error) {
			console.error('[BG] Fatal error in main process loop: ', error);
		}
	})();
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
		await db.collection(`chats/${keyId}/messages`).add({
			userId: event.source.userId,
			messageId: event.message.id,
			message: event.message.text,
			createdAt: FieldValue.serverTimestamp(),
			// TTL 用に正確な日付型で管理
			// 日単位をミリ秒に変換して現在の時刻に足す
			expireAt: Timestamp.fromMillis(Date.now() + process.env.DB_MESSAGE_EXPIRE_DAYS * 24 * 60 * 60 * 1000)
		});

		console.log(`[addMessageToDb] User message added - ${event.message.id}`);
	} catch (error) {
		// 呼び出し元で分かりやすくするためにエラーをラップする
		throw new Error(`[addMessageToDb] Error adding user message (${event.message.id}): ${error.message}`, { cause: error });
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
			contents: `${process.env.PROMPT_CHECK_SUMMARIZATION}
			---
			${text}
			---`
		});

		if (response.text === 'Y') {
			return true;
		} else if (response.text === 'N') {
			return false;
		} else {
			throw new Error('[checkSummarization] AI generated unexpected response');
		}
	} catch (error) {
		throw new Error(`[checkSummarization] Error checking summarization: ${error.message}`, { cause: error });
	}
}

/**
 * 特定IDのチャット履歴を要約する
 * 失敗した場合例外を投げる
 * @param {{ source: { userId: string?, groupId: string?, roomId: string? }, message: { id: string, text: string } }} event
 * @returns
 */
async function summarize(event) {
	const keyId = event.source.groupId || event.source.roomId || event.source.userId;
	try {
		// IDごとのドキュメント取得
		const chatDoc = await db.collection('chats').doc(keyId).get();

		// ドキュメントの最終要約日時を取得
		// undefined の場合まだ要約されたことがないので、UNIXエポックにしておく
		const docsLastSummarizedAt = chatDoc.data()?.lastSummarizedAt || new Date(0);

		// クエリのパイプライン化
		// メッセージの中から > 最終要約日時以降に追加されたメッセージを抽出し > 昇順（古い順）に並べ替え > 100件まで取得
		const pipeline = db.pipeline().collection(`chats/${keyId}/messages`)
			.where(field('createdAt').greaterThan(docsLastSummarizedAt))
			.sort(field('createdAt').ascending())
			.limit(100);

		// 該当メッセージ取得
		const snapshot = await pipeline.execute();

		// 該当するものが無ければ終了
		if (snapshot.results.length === 0) {
			return;
		}

		// 要約対象のメッセージを Markdown のリスト化
		const listText = snapshot.results
			.map((r) => r.data()?.message)
			.filter((msg) => msg !== undefined && typeof msg === 'string')
			.map((msg) => `- ${msg}`)
			.join('\n');

		// Gemini
		const response = await ai.models.generateContent({
			model: 'gemini-3.6-flash',
			contents: `${process.env.PROMPT_SUMMARIZE}\n${listText}`
		});

		// 要約対象の中で最新のタイムスタンプ
		const lastSummarizedAt = snapshot.results.at(-1).data().createdAt;

		// バッチ処理はじめ
		const batch = db.batch();

		// 要約保存
		batch.set(db.collection(`chats/${keyId}/summaries`).doc(), {
			text: response.text,
			// 要約対象の中で最新のタイムスタンプを参照する
			summarizedAt: lastSummarizedAt,
			// 何個のメッセージから要約したか
			messageCount: snapshot.results.length,
			createdAt: FieldValue.serverTimestamp()
		});

		// タイムスタンプ更新
		batch.set(db.collection('chats').doc(keyId), {
			lastSummarizedAt: lastSummarizedAt,
			updatedAt: FieldValue.serverTimestamp()
		}, {
			// 既存フィールドを上書きするように
			merge: true
		});

		// 要約保存とタイムスタンプ更新の両方を行う
		// 原子性
		await batch.commit();

		console.log(`[summarize] Summary added - ${keyId}`);

		return response.text;
	} catch (error) {
		throw new Error(`[summarize] Error summarization: ${error.message}`, { cause: error });
	}
}
