import type { TargetLanguage } from "../../shared/languages.js";

// This is a skip predicate, not a language detector. Uncertainty must leave a
// block eligible for translation; the caller may also bypass it for retranslate.
const HAN = /\p{Script=Han}/u;
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}ー]/u;
const HANGUL = /\p{Script=Hangul}/u;
const LATIN = /\p{Script=Latin}/u;
const LETTER = /\p{L}/u;

// A deliberately bounded set, not a Chinese conversion dictionary. An unknown
// Han character prevents skipping, even when the ancestor says lang="zh-CN".
// Ambiguous simplified forms (后/里/干/发, etc.) stay out of the neutral set.
const NEUTRAL_HAN = new Set(Array.from(
  "一二三四五六七八九十百千万人口大小上下左右前中本今明早晚春夏秋冬日月水火木土山川天地海河湖雨雪" +
  "白黑赤青金玉石田生年男女老少父母子女兄弟姐妹朋友人人我你他她它自己每各有无不非否未末也又很太多" +
  "好全完新古旧可必需共只及以于而如果因所以但是先再次此彼些那什怎何何其或与和的了是在得地就要能会" +
  "去来回出入上下到近远高低内外同异前后使使用内容文章段落标题页网站句字词语文中文英文中文名姓名数" +
  "目目的方法例子程式程序版本模式格式位置原正文正文文本信息消息功能能力性能速度时间开始停止完成" +
  "保留取消点击保存清除窗口视图屏幕手机电脑浏览阅读显示颜色背景样式设置系统模型账户登录退出请求" +
  "失败成功错误结果问题处理本地真实实际自动动态发现识别支持连接等待当前已经重复再次普通公开私密" +
  "心手足耳目身走坐立行止看听言笑光气天气空风音声电力工作学习生活食米麦豆茶酒牛羊犬猫鱼鸟虫花草林" +
  "州城村家室门户房车船马路方向南北东西远近长短深浅多少正反直平安宁永每所有都更最相互另外同时" +
  "测验测试示范展示介介绍应对并且然后继续帮助变成数据来源目标简繁体翻译断网刷新重试一个通常这样切部分起野季化第",
));
const SIMPLIFIED_HAN = new Set(Array.from(
  "万与专业东丝丢两严个为丽举么义乌乐习乡书买乱争于亏云亚产亩亲亿仅从仑仓仪们价众优会伞伟传伤伦体余面" +
  "儿兑党兰关兴养兽冈册写军农冲决况冻净准几凤凭击凿则刚创删别刮制剂剑办务动励劳势勋匀区医华协单卖占卢卫却厂历厉压厌县参双" +
  "发变叙叶号叹听启吴呐呕员呛响哑唤啸喷团园围国图圆圣场坏块坚坛坝坟坠垄垒垦垫堑墙壮声壳处备复够头夹夺奋奖妇妈孙学宁宝实审宪宫宽宾对寻导寿将尘尝尔尽层属岁岂岗岛岭岳峡币帅师帐帘帜带帮干并广庄庆库应庙废开异弃张弥弯弹归录当彻径忆忧怀态怜总恶悬惊惧惨惯愿戏户扩扫扬扰抚抛抢护报担拟拢拣拥择挤挥损换据掷掸掺揽搀搁搂搅携摄摆摇摊撑撵敌数断无旧时旷显晋晓晕暂术朴机杀杂权条来杨极构标树样栈栋栏梦检楼欢欧残毁毕气汇汉沟没泽洁浅浆浇测济浑浓涛润涌涡温湾湿滚满滤滥滨灭灯灵灾灿炉点炼热爱爷牵犹独狭狱获猎猪猫献环现玺画畅疗疟疯疮痪瘫皱盖盘着矿码砖确碍礼祷祸离种积称秽稳穷窃窍竞笔笋笺筑签简箩篓篮粮糟纠红约级纪纤纯纱纲纳纵纷纸纹纺纽线练组细织终绊绍经绑结绕绘给络绝绞统绣继续绿维绵绷绸综绽绳缩缴网罗罚罢职联聪肃肠肤肾肿胀胁胆胜胶脉脏脑脚脸腊腾舆舰舱艰艳艺节芜芦苇苹范茎茧荆荐荚荡荣药莱莲莹营萧蓝蓟蔷蕴虑虚虫虽虾蚀蚁蚂蚕蛊蛮补装裤襄见观规视览觉触誉计订认讨让训议讯记讲讳讶许论讼设访诀证评诅识诈诉诊词译试诗诚话诞询诣该详语误说请诸诺读课谁调谈谅谊谋谍谎谐谜谢谣谨谬谱谴贝贞负财贡贫货质贩贪贯责贤败账贬购贮贵贷贸费贺贼贾贿赁赂赃资赊赋赌赎赏赐赔赖赘赚赛赞赠赵赶趋跃践跷踊踪蹒车轨转轮软轰轻载轿较辅辆辈辉辑输辙辞辟边辽达迁过迈运还这进远违连迟适选递逻遗遥邮邻郑酿释里鉴针钉钓钟钢钱铁铃铜银铺链锁锅锋错锚键锻镇镜长门闭问闯闲间闷闸闹闻阀阁阅队阳阴阵阶际陆陈陕陨险随隐隶难雏雾静韵页顶顷项顺须顾顿预颁颂领颇频颗题颜额风飞饥饭饮饰饱饼饿馆马驭驰驱驻驶骂验骑骗骚骤鱼鸟鸡鸣鸭鸽鹅鹰麦黄齐齿龄龙龟",
));
const TRADITIONAL_HAN = new Set(Array.from(
  "萬與專業東絲丟兩嚴個為麗舉麼義烏樂習鄉書買亂爭於虧雲亞產畝親億僅從侖倉儀們價眾優會傘偉傳傷倫體餘麵" +
  "兒兌黨蘭關興養獸岡冊寫軍農沖決況凍淨準幾鳳憑擊鑿則剛創刪別劑劍辦務動勵勞勢勳勻區醫華協單賣盧衛卻廠歷厲壓厭縣參雙" +
  "發髮變敘葉號嘆聽啟吳吶嘔員嗆響啞喚嘯噴團園圍國圖圓聖場壞塊堅壇壩墳墜壟壘墾墊塹牆壯聲殼處備復複夠頭夾奪奮獎婦媽孫學寧寶實審憲宮寬賓對尋導壽將塵嘗爾盡層屬歲豈崗島嶺峽幣帥師帳簾幟帶幫幹乾並廣莊慶庫應廟廢開異棄張彌彎彈歸錄當徹徑憶憂懷態憐總惡懸驚懼慘慣願戲戶擴掃揚擾撫拋搶護報擔擬攏揀擁擇擠揮損換據擲撣摻攬攙擱摟攪攜攝擺搖攤撐攆敵數斷無舊時曠顯晉曉暈暫術樸機殺雜權條來楊極構標樹樣棧棟欄夢檢樓歡歐殘毀畢氣匯漢溝沒澤潔淺漿澆測濟渾濃濤潤湧渦溫灣濕滾滿濾濫濱滅燈靈災燦爐點煉熱愛爺牽猶獨狹獄獲獵豬貓獻環現璽畫暢療瘧瘋瘡瘓癱皺蓋盤礦碼磚確礙禮禱禍離種積稱穢穩窮竊竅競筆筍箋築簽簡籮簍籃糧糾紅約級紀纖純紗綱納縱紛紙紋紡紐線練組細織終絆紹經綁結繞繪給絡絕絞統繡繼續綠維綿繃綢綜綻繩縮繳網羅罰罷職聯聰肅腸膚腎腫脹脅膽勝膠脈臟腦腳臉臘騰輿艦艙艱艷藝節蕪蘆葦蘋莖繭荊薦莢蕩榮藥萊蓮瑩營蕭藍薊薔蘊慮虛蟲雖蝦蝕蟻螞蠶蠱蠻補裝褲見觀規視覽覺觸譽計訂認討讓訓議訊記講諱訝許論訟設訪訣證評詛識詐訴診詞譯試詩誠話誕詢詣該詳語誤說請諸諾讀課誰調談諒誼謀諜謊諧謎謝謠謹謬譜譴貝貞負財貢貧貨質販貪貫責賢敗賬貶購貯貴貸貿費賀賊賈賄賃賂贓資賒賦賭贖賞賜賠賴贅賺賽贊贈趙趕趨躍踐蹺踴蹤蹣車軌轉輪軟轟輕載轎較輔輛輩輝輯輸轍辭邊遼達遷過邁運還這進遠違連遲適選遞邏遺遙郵鄰鄭釀釋裡裏鑑針釘釣鐘鋼錢鐵鈴銅銀鋪鏈鎖鍋鋒錯錨鍵鍛鎮鏡長門閉問闖閒間悶閘鬧聞閥閣閱隊陽陰陣階際陸陳陝隕險隨隱隸難雛霧靜韻頁頂頃項順須顧頓預頒頌領頗頻顆題顏額風飛飢飯飲飾飽餅餓館馬馭馳驅駐駛罵驗騎騙騷驟魚鳥雞鳴鴨鴿鵝鷹麥黃齊齒齡龍龜後",
));
for (const character of [...SIMPLIFIED_HAN, ...TRADITIONAL_HAN]) NEUTRAL_HAN.delete(character);

const CHINESE_MARKERS = ["的", "了", "是", "在", "和", "可以", "需要", "没有", "沒有", "已经", "已經", "因为", "因為", "所以", "但是", "这个", "這個", "我们", "我們"];
const LATIN_MARKERS: Record<"en" | "fr" | "de" | "es", ReadonlySet<string>> = {
  en: new Set("the this that these those with from which their they our your are is and for to of have has was were will not".split(" ")),
  fr: new Set("le la les des du une dans pour avec sur pas est sont nous vous aux cette ces leur leurs mais qui que et".split(" ")),
  de: new Set("der die das den dem des ein eine einer einen einem und ist sind nicht mit für von auf zu im am auch als werden wird diese dieser dieses sich".split(" ")),
  es: new Set("el la los las una unos unas del que y en es son para por con como pero esta este estos estas esto sus nos les más no".split(" ")),
};

function hintBase(hint: string | undefined): string | undefined {
  const normalized = hint?.trim().toLowerCase();
  return normalized && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(normalized) ? normalized.split("-")[0] : undefined;
}

/** True only when local evidence is strong enough to leave the original visible. */
export function isAlreadyTargetLanguage(text: string, target: TargetLanguage, languageHint?: string): boolean {
  const normalized = text.normalize("NFC");
  const letters = Array.from(normalized).filter((character) => LETTER.test(character));
  if (!letters.length) return true;

  const hint = hintBase(languageHint);
  const han = letters.filter((character) => HAN.test(character));
  const kana = letters.filter((character) => KANA.test(character));
  const hangul = letters.filter((character) => HANGUL.test(character));
  if (target === "zh-CN" || target === "zh-TW") {
    if (han.length !== letters.length || han.length < 12 || hint === "ja" || hint === "ko") return false;
    const native = target === "zh-CN" ? SIMPLIFIED_HAN : TRADITIONAL_HAN;
    const foreign = target === "zh-CN" ? TRADITIONAL_HAN : SIMPLIFIED_HAN;
    if (han.some((character) => foreign.has(character)
      || (!native.has(character) && !NEUTRAL_HAN.has(character)))) return false;
    return CHINESE_MARKERS.filter((marker) => normalized.includes(marker)).length >= 2;
  }
  if (target === "ja") {
    return han.length + kana.length === letters.length && kana.length >= 8 && kana.length / letters.length >= 0.3
      && normalized.split(/[.!?。！？;；\n]+/u).every((sentence) =>
        !LETTER.test(sentence) || KANA.test(sentence));
  }
  if (target === "ko") return hangul.length === letters.length && hangul.length >= 12;

  if (hint !== target || letters.some((character) => !LATIN.test(character))) return false;
  const words = normalized.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (words.length < 10 || letters.length < 40) return false;
  const targetMarkers = LATIN_MARKERS[target];
  const counts = Object.entries(LATIN_MARKERS).map(([language, markers]) => ({
    language,
    hits: words.filter((word) => markers.has(word)).length,
    distinct: new Set(words.filter((word) => markers.has(word))).size,
    exclusive: new Set(words.filter((word) => markers.has(word) && !targetMarkers.has(word))).size,
  }));
  const own = counts.find((count) => count.language === target)!;
  const others = counts.filter((count) => count.language !== target);
  return own.distinct >= 3 && own.hits / words.length >= 0.25
    && others.every((count) => count.exclusive < 3 && own.hits >= count.hits + 2);
}
