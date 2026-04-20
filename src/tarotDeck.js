/**
 * 塔罗牌库：从 CSV 解析，抽牌逻辑与路径约定（牌面 public 根目录）。
 */

/**
 * 解析牌库 CSV（含表头）。
 * 支持两种结构：
 * - 旧版: card_id,name,description,image_key,result_image,is_active
 * - 新版: card_id,name,description,Tags_1,Tags_2,Tags_3,image_key,result_image,is_active
 * 支持 description 中含英文逗号：通过尾部固定列回推 description 结束位置。
 */
export function parseTarotDeckCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const out = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    const segs = line.split(',');
    if (segs.length < 6) continue;
    const isActive = segs[segs.length - 1].trim();
    if (isActive !== '1') continue;
    const resultImage = segs[segs.length - 2].trim();
    const imageKey = segs[segs.length - 3].trim();
    const cardId = Number(segs[0].trim());
    const name = segs[1].trim();
    const tagTail = segs.slice(segs.length - 6, segs.length - 3);
    const hasTagFields = segs.length >= 9;
    const [tags1Raw, tags2Raw, tags3Raw] = hasTagFields ? tagTail : ['', '', ''];
    const descriptionEnd = hasTagFields ? segs.length - 6 : segs.length - 3;
    const description = segs.slice(2, descriptionEnd).join(',').trim();
    const tags = [tags1Raw, tags2Raw, tags3Raw].map((t) => (t ?? '').trim()).filter(Boolean);
    if (!Number.isFinite(cardId) || !name) continue;
    out.push({
      id: cardId,
      name,
      description,
      tags1: (tags1Raw ?? '').trim(),
      tags2: (tags2Raw ?? '').trim(),
      tags3: (tags3Raw ?? '').trim(),
      tags,
      imageKey,
      /** 牌背等资源路径：'/' + card.imageKey */
      backFilename: imageKey,
      /** 牌面（解读展示）：'/' + card.filename */
      filename: resultImage,
      resultImage,
    });
  }
  return out;
}

/**
 * 从牌库随机抽取 3 张（允许重复），分别对应过去 / 现在 / 未来。
 * @param {Array<object>} deck
 * @returns {{ pastCard: object, presentCard: object, futureCard: object }}
 */
export function drawCards(deck) {
  if (!deck?.length) {
    return { pastCard: null, presentCard: null, futureCard: null };
  }
  const pick = () => deck[Math.floor(Math.random() * deck.length)];
  return {
    pastCard: pick(),
    presentCard: pick(),
    futureCard: pick(),
  };
}

export function cardImageSrc(card, which = 'face') {
  if (!card) return '';
  const fn = which === 'back' ? card.backFilename ?? card.imageKey : card.filename ?? card.resultImage;
  if (!fn) return '';
  return fn.startsWith('/') ? fn : `/${fn}`;
}
