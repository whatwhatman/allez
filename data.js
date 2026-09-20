/* Allez! 法语备考引擎 — 数据层
   全部离线数据：法语词典（含 CEFR 等级与中文义）、停用词、不规则动词变位、母语负迁移易错点库。 */

/* ---------- 1. 法语停用词 + 功能词 ---------- */
const FR_STOP = new Set(`
le la les l un une des du de d au aux a à de par pour avec sans dans sur sous chez vers dans entre depuis pendant avant après contre
et ou ni mais donc or car que qui quoi dont où si comme quand lorsque alors ainsi aussi très trop tout toute tous toutes bien peu plus moins
je tu il elle nous vous ils elles on ce cette cet ces mon ma mes ton ta tes son sa ses notre nos votre vos leur leurs
est sont suis es sommes êtes était étaient être eu ai as avons avez ont avaient sera seraient été ont être être
avait avaient aurait auraient avoir ayant eu eue eus eues
ne pas plus jamais rien personne aucun aucune n ne me te se nous vous lui leur y en
suis es est-ce est ce cest c j jai ja quil qui qua quon qua au eu aux du eu en la de des dois doit doivent fait faire faire
 un une des du ce cette ces cet quel quelle quels quelles
pour afin alors encore déjà souvent toujours jamais peutêtre peut toujours maintenant hier demain aujourd'hui
voici voilà ici là où partout ailleurs comme comment combien pourquoi pourquoi quel
 très très très même autres autre autre chose gens monde chose chose fois peu beaucoup trop
 au moins soit ou encore puis enfin d abord tout dabord
 près selon malgré jusque puis ensuite ainsi cependant néanmoins puisque quoique lorsque alors lorsque tandis donc or ni car
 voici voilà partout ailleurs combien pourquoi comment quelle quelles quels quel dont celui celle ceux celles
 zero un deux trois quatre cinq six sept huit neuf dix onze douze treize quatorze quinze seize
 vingt trente quarante cinquante soixante quatrevingts cent mille million milliard premier première
 lundi mardi mercredi jeudi vendredi samedi dimanche janvier février mars avril mai juin juillet août septembre octobre novembre décembre
`.trim().split(/\s+/).filter(Boolean));

/* ---------- 2. 核心法语词典 word|pos|CEFR|gender|中文字典义 ---------- */
const DICT_RAW = `
être|v|A1||是；存在
avoir|v|A1||有
aller|v|A1||去
faire|v|A1||做；制造
venir|v|A1||来
partir|v|A1||出发
arriver|v|A1||到达
entrer|v|A1||进入
sortir|v|A1||出去
monter|v|A1||上（楼、车）
descendre|v|A2||下（楼、车）
tomber|v|A2||跌倒；掉落
naître|v|B1||出生
mourir|v|B1||死亡
rester|v|A1||留下；停留
devenir|v|A2||变成
pouvoir|v|A1||能够
vouloir|v|A1||想要
devoir|v|A1||应该；欠
prendre|v|A1||拿；乘（车）
comprendre|v|A2||理解
apprendre|v|A1||学习；得知
mettre|v|A1||放；穿
voir|v|A1||看见
regarder|v|A1||看；观看
dire|v|A1||说
parler|v|A1||说话
écouter|v|A1||听
entendre|v|A2||听见
lire|v|A1||阅读
écrire|v|A1||写
savoir|v|A1||知道；会
connaître|v|A2||认识；熟悉
croire|v|A2||相信
penser|v|A1||想；认为
trouver|v|A1||找到；觉得
chercher|v|A1||寻找
donner|v|A1||给
demander|v|A1||问；要求
répondre|v|A2||回答
attendre|v|A1||等待
payer|v|A1||支付
acheter|v|A1||购买
vendre|v|A2||卖
manger|v|A1||吃
boire|v|A1||喝
dormir|v|A1||睡觉
se réveiller|v|A2||醒来
se lever|v|A1||起床
se coucher|v|A2||就寝
habiter|v|A1||居住
vivre|v|A2||生活；居住
travailler|v|A1||工作
étudier|v|A1||学习（大学）
apprendre|v|A1||学会
enseigner|v|A2||教
commencer|v|A1||开始
finir|v|A1||结束
continuer|v|A2||继续
arrêter|v|A2||停止
aimer|v|A1||喜欢
adorer|v|A2||酷爱
détester|v|A2||讨厌
préférer|v|A2||更喜欢
espérer|v|A2||希望
attendre|v|A1||期待
oublier|v|A2||忘记
se souvenir|v|B1||记得
choisir|v|A2||选择
décider|v|A2||决定
essayer|v|A2||尝试
réussir|v|A2||成功
utiliser|v|A2||使用
emporter|v|B1||带走
apporter|v|A2||带来
montrer|v|A2||出示
ouvrir|v|A1||打开
fermer|v|A1||关闭
nettoyer|v|A2||打扫
préparer|v|A2||准备
cuisiner|v|B1||烹饪
aimer|v|A1||爱
porter|v|B1||穿；携带
mettre|v|A1||穿戴
changer|v|A2||改变
tomber|v|A2||落下
plaire|v|B1||使愉快
falloir|v|A2||必须（无人称）
valoir|v|B1||值得
voyager|v|A2||旅行
visiter|v|A1||参观
rencontrer|v|A2||遇见
quitter|v|B1||离开
revenir|v|A2||回来
rentrer|v|A2||回家
dépendre|v|B1||取决于
 utilisé|v|A2||使用（过去分词）
jour|n|A1|m|一天；日子
journée|n|A2|f|一整天
matin|n|A1|m|早晨
soir|n|A1|m|傍晚
nuit|n|A1|f|夜晚
semaine|n|A1|f|星期
mois|n|A1|m|月份
année|n|A1|f|年份
heure|n|A1|f|小时；时间
temps|n|A1|m|时间；天气
 aujourd'hui|adv|A1||今天
 demain|adv|A1||明天
 hier|adv|A1||昨天
 maintenant|adv|A1||现在
fois|n|A1|f|次
moment|n|A2|m|时刻
vie|n|A2|f|生活；生命
monde|n|A1|m|世界；人们
gens|n|A1|m||人们
personne|n|A1|f|人；无人
homme|n|A1|m|男人；人类
femme|n|A1|f|女人；妻子
enfant|n|A1|m|孩子
garçon|n|A1|m|男孩；小伙子
fille|n|A1|f|女孩；女儿
ami|n|A1|m|朋友（男）
amie|n|A1|f|朋友（女）
parent|n|A2|m|父母；亲属
père|n|A1|m|父亲
mère|n|A1|f|母亲
frère|n|A1|m|兄弟
soeur|n|A1|f|姐妹
mari|n|A2|m|丈夫
copain|n|A1|m|伙伴
voisin|n|A2|m|邻居
professeur|n|A1|m|老师
étudiant|n|A1|m|大学生（男）
étudiante|n|A1|f|大学生（女）
élève|n|A1|m|学生
camarade|n|A2|m|同学
école|n|A1|f|中小学
université|n|A1|f|大学
cours|n|A1|m|课程
classe|n|A1|f|班级
prof|n|A2|m||老师（口语）
examen|n|A2|m|考试
diplôme|n|B1|m|文凭
maison|n|A1|f|房子；家
appartement|n|A1|m|公寓
chambre|n|A1|f|房间
cuisine|n|A1|f|厨房
salon|n|A2|m|客厅
salle|n|A2|f|厅；室
toilettes|n|A2|f||洗手间
ville|n|A1|f|城市
village|n|A2|m|村庄
pays|n|A1|m|国家
quartier|n|A2|m|街区
rue|n|A1|f|街道
route|n|A2|f|公路
école|n|A1|f|学校
magasin|n|A1|m|商店
marché|n|A2|m|市场
restaurant|n|A1|m|餐馆
café|n|A1|m|咖啡馆；咖啡
hôtel|n|A1|m|旅馆
banque|n|A2|f|银行
hôpital|n|A2|m|医院
pharmacie|n|A2|f|药房
gare|n|A2|f|火车站
aéroport|n|A2|m|机场
train|n|A1|m|火车
avion|n|A1|m|飞机
bus|n|A1|m|公共汽车
métro|n|A1|m|地铁
vélo|n|A1|m|自行车
voiture|n|A1|f|汽车
billet|n|A2|m|票
bagage|n|B1|m|行李
nourriture|n|A2|f|食物
eau|n|A1|f|水
pain|n|A1|m|面包
viande|n|A2|f|肉
légume|n|A2|m|蔬菜
fruit|n|A2|m|水果
fromage|n|A2|m|奶酪
repas|n|A2|m|餐
petit-déjeuner|n|A2|m|早餐
déjeuner|n|A2|m|午餐
dîner|n|A2|m|晚餐
addition|n|B1|f|账单
argent|n|A1|m|钱
prix|n|A1|m|价格
travail|n|A1|m|工作
emploi|n|B1|m|职位
bureau|n|A2|m|办公室；书桌
entreprise|n|B1|f|企业
métier|n|B1|m|职业
salaire|n|B1|m|工资
lettre|n|A2|f|信；字母
livre|n|A1|m|书
journal|n|A2|m|报纸
document|n|B1|m|文件
carte|n|A2|f|地图；卡片
cinéma|n|A1|m|电影院
film|n|A1|m|电影
musique|n|A1|f|音乐
spectacle|n|B1|m|演出
théâtre|n|B1|m|剧院；戏剧
 sport|n|A1|m|运动
match|n|A2|m|比赛
jeu|n|A2|m|游戏
vacances|n|A1|f||假期
voyage|n|A1|m|旅行
 paysage|n|B1|m|风景
mer|n|A1|f|海
montagne|n|A2|f|山
campagne|n|A2|f|乡村
forêt|n|B1|f|森林
plage|n|A1|f|海滩
soleil|n|A1|m|太阳
pluie|n|A2|f|雨
neige|n|A2|f|雪
temps|n|A1|m|天气
problème|n|A1|m|问题
question|n|A1|f|问题
réponse|n|A2|f|回答
exemple|n|A2|m|例子
chose|n|A1|f|事情
raison|n|A2|f|理由
droite|n|A2|f|右；法律
langue|n|A2|f|语言；舌头
mot|n|A1|m|词
phrase|n|A2|f|句子
histoire|n|A1|f|历史；故事
GRADE|n|B1|m|等级
bon|adj|A1||好的
bonne|adj|A1||好的（阴）
mauvais|adj|A1||坏的
grand|adj|A1||大的；高的
petit|adj|A1||小的
jeune|adj|A1||年轻的
vieux|adj|A1||老的
nouveau|adj|A1||新的
nouvelle|adj|A1||新的（阴）
ancien|adj|B1||旧的；从前的
beau|adj|A1||美丽的
joli|adj|A2||漂亮的
content|adj|A1||高兴的
heureux|adj|A2||幸福的
triste|adj|A2||悲伤的
fatigué|adj|A1||疲劳的
malade|adj|A2||生病的
gentil|adj|A2||亲切的
sympathique|adj|A2||讨人喜欢的
facile|adj|A1||容易的
difficile|adj|A1||困难的
important|adj|A2||重要的
possible|adj|A2||可能的
nécessaire|adj|B1||必要的
utile|adj|A2||有用的
prêt|adj|A2||准备好的
cher|adj|A2||贵的；亲爱的
chaud|adj|A1||热的
froid|adj|A1||冷的
rapide|adj|A2||快的
 lent|adj|A2||慢的
premier|adj|A2||第一
dernier|adj|A2||最后的
même|adj|A2||同样的
tel|adj|B1||这样的
prochain|adj|A2||下一个
seul|adj|A2||单独的
tout|adj|A1||全部的
libre|adj|A2||自由的；空闲的
très|adv|A1||非常
trop|adv|A1||太
peu|adv|A1||少
beaucoup|adv|A1||很多
 toujours|adv|A1||总是
jamais|adv|A1||从不
souvent|adv|A1||经常
rarement|adv|A2||很少
déjà|adv|A1||已经
encore|adv|A1||还；再
vite|adv|A2||快
bien|adv|A1||好
mal|adv|A2||坏
vraiment|adv|A2||真的
 ici|adv|A1||这里
là|adv|A1||那里
ensemble|adv|A2||一起
alors|adv|A1||那么
aujourd'hui|adv|A1||今天
beaucoup|adv|A1||许多
avec|p|A1||和…一起
sans|p|A1||没有
dans|p|A1||在…里
sur|p|A1||在…上
sous|p|A2||在…下
pour|p|A1||为了
par|p|A1||被；经由
avant|p|A2||在…之前
après|p|A2||在…之后
pendant|p|A2||在…期间
depuis|p|B1||自从
entre|prep|A2||在…之间
vers|p|B1||朝；大约
chez|p|A2||在…家
 contre|p|B1||反对
car|conj|A2||因为
donc|conj|A2||因此
mais|conj|A1||但是
ou|conj|A1||或者
si|conj|A2||如果；是否
quand|conj|A1||当…时候
 parce que|conj|A2||因为
pendant que|conj|B1||当…期间
 bien que|conj|B2||虽然
afin que|conj|B2||以便
alors que|conj|B2||然而
et|conj|A1||和
 chose|n|A1|f|事物
 état|n|B1|m|状态；国家
 cas|n|B2|m|情况
 lieu|n|B1|m|地点
 rue|n|A1|f|街
 action|n|B1|f|行动
 rôle|n|B1|m|角色
 niveau|n|B2|m|水平
 cours|n|A1|m|课
 objet|n|B1|m|物品
 face|n|B1|f|面；面对
 fois|n|A1|f|回
 plupart|n|B2|f|大部分
 changement|n|B1|m|变化
 climat|n|B1|m|气候
 environnement|n|B1|m|环境
 société|n|B1|f|社会
 gouvernement|n|B2|m|政府
 pays|n|A1|m|国
 opinion|n|B2|f|观点
 intérêt|n|B2|m|兴趣；利益
 consequent|adj|B2||随之发生的
 grâce|n|B2|f|感激；多亏
 appeler|v|A2||叫；打电话
 passer|v|A1||经过；度过
 annoncer|v|B1||宣布
 expliquer|v|A2||解释
 inviter|v|A2||邀请
 partager|v|A2||分享
 réfléchir|v|B1||思考
 réserver|v|A2||预订
 terminer|v|A1||完成
 installer|v|B1||安装；安顿
 louer|v|B1||租用；出租
 loger|v|B1||住宿
 rouler|v|B1||开车；滚动
 nager|v|A2||游泳
 jouer|v|A1||玩；演奏
 danser|v|A1||跳舞
 chanter|v|A1||唱歌
 conduire|v|B1||驾驶
 traduire|v|B1||翻译
 produire|v|B1||生产
 réduire|v|B1||减少
 construire|v|B1||建造
 détruire|v|B1||摧毁
 indiquer|v|B1||指出
 présenter|v|A2||介绍；呈现
 représenter|v|B1||代表
 développer|v|B1||发展
 participer|v|B1||参与
 profiter|v|B1||利用；享受
 améliorer|v|B1||改善
 prévoir|v|B1||预见；计划
 paraître|v|B1||显得
 reconnaître|v|B1||认出
 disparaître|v|B1||消失
 apparaître|v|B1||出现
 obtenir|v|B1||获得
 maintenir|v|B2||维持
 permettre|v|B1||允许
 promettre|v|B2||承诺
 surprendre|v|B1||使惊讶
 entreprendre|v|B2||着手
 devenir|v|A2||变成
 revenir|v|A2||回来
se reposer|v|A2||休息
 s'intéresser|v|B1||对…感兴趣
 se soucier|v|B2||关心
 se demander|v|B1||自问
 occuper|v|B1||占据
 remplacer|v|B2||替代
 augmenter|v|B1||增加
 diminuer|v|B1||减少
 durer|v|A2||持续
 commencer|v|A1||开始
 continuer|v|A2||继续
 traverser|v|B1||穿过
 emmener|v|B1||带走
 rapporter|v|B2||带回
 hésiter|v|B2||犹豫
`;

/* ---------- 3. 不规则动词  inf|pres6|subj6|futStem|pp,aux ---------- */
const VERB_RAW = `
être|suis,es,est,sommes,êtes,sont|sois,sois,soit,soyons,soyez,soient|ser|été,avoir
avoir|ai,as,a,avons,avez,ont|aie,aies,ait,ayons,ayez,aient|aur|eu,avoir
aller|vais,vas,va,allons,allez,vont|aille,ailles,aille,allions,alliez,aillent|ir|allé,être
faire|fais,fais,fait,faisons,faites,font|fasse,fasses,fasse,fassions,fassiez,fassent|fer|fait,avoir
pouvoir|peux,peux,peut,pouvons,pouvez,peuvent|puisse,puisses,puisse,pouissions,pouviez,puissent|pourr|pu,avoir
vouloir|veux,veux,veut,voulons,voulez,veulent|veuille,veuilles,veuille,voulions,vouliez,veuillent|voudr|voulu,avoir
devoir|dois,dois,doit,devons,devez,doivent|doive,doives,doive,devions,deviez,doivent|devr|dû,avoir
venir|viens,viens,vient,venons,venez,viennent|vienne,viennes,vienne,venions,veniez,viennent|viendr|venu,être
tenir|tiens,tiens,tient,tenons,tenez,tiennent|tienne,tiennes,tienne,tenions,teniez,tiennent|tiendr|tenu,avoir
prendre|prends,prends,prend,prenons,prenez,prennent|prenne,prennes,prenne,prenions,preniez,prennent|prendr|pris,avoir
comprendre|comprends,comprends,comprend,comprenons,comprennez,comprennent|comprenne,comprennes,comprenne,comprenions,compreniez,comprennent|comprendr|compris,avoir
apprendre|apprends,apprends,apprend,apprenons,apprenez,apprennent|apprenne,apprennes,apprenne,apprenions,appreniez,apprennent|apprendr|appris,avoir
mettre|mets,mets,met,mettons,mettez,mettent|mette,mettes,mette,mettions,mettiez,mettent|mettr|mis,avoir
voir|vois,vois,voit,voyons,voyez,voient|voie,voies,voie,voyions,voyiez,voient|verr|vu,avoir
dire|dis,dis,dit,disons,dites,disent|dise,dises,dise,disions,disiez,disent|dir|dit,avoir
savoir|sais,sais,sait,savons,savez,savent|sache,saches,sache,sachions,sachiez,sachent|saur|su,avoir
partir|pars,pars,part,partons,partez,partent|parte,partes,parte,partions,partiez,partent|partir|parti,être
sortir|sors,sors,sort,sortons,sortez,sortent|sorte,sortes,sorte,sortions,sortiez,sortent|sortir|sorti,être
écrire|écris,écris,écrit,écrivons,écrivez,écrivent|écrive,écrives,écrive,écrivions,écriviez,écrivent|écrir|écrit,avoir
lire|lis,lis,lit,lisons,lisez,lisent|lise,lises,lise,lisions,lisiez,lisent|lir|lu,avoir
boire|bois,bois,boit,buvons,buvez,boivent|boive,boives,boive,buvions,buviez,boivent|boir|bu,avoir
connaître|connais,connais,connaît,connaissons,connaissez,connaissent|connaisse,connaisses,connaisse,connaissions,connaissiez,connaissent|connaîtr|connu,avoir
recevoir|reçois,reçois,reçoit,recevons,recevez,reçoivent|reçoive,reçoives,reçoive,recevions,receviez,reçoivent|recevr|reçu,avoir
ouvrir|ouvre,ouvres,ouvre,ouvrons,ouvrez,ouvrent|ouvre,ouvres,ouvre,ouvrions,ouvriez,ouvrent|ouvrir|ouvert,avoir
offrir|offre,offres,offre,offrons,offrez,offrent|offre,offres,offre,offrions,offriez,offrent|offrir|offert,avoir
dormir|dors,dors,dort,dormons,dormez,dorment|dorme,dormes,dorme,dormions,dormiez,dorment|dormir|dormi,avoir
servir|sers,sers,sert,servons,servez,servent|serve,serves,serve,servions,serviez,servent|servir|servi,avoir
courir|cours,cours,court,courons,courez,courent|coure,coures,coure,courions,couriez,courent|courr|couru,avoir
croire|crois,crois,croit,croyons,croyez,croient|croie,croies,croie,croyions,croyiez,croient|croir|cru,avoir
vivre|vis,vis,vit,vivons,vivez,vivent|vive,vives,vive,vivions,viviez,vivent|vivr|vécu,avoir
suivre|suis,suis,suit,suivons,suivez,suivent|suive,suives,suive,suivions,suiviez,suivent|suivr|suivi,avoir
naître|nais,nais,naît,naissons,naissez,naissent|naisse,naisses,naisse,naissions,naissiez,naissent|naîtr|né,être
mourir|meurs,meurs,meurt,mourons,mourez,meurent|meure,meures,meure,mourions,mouriez,meurent|mourr|mort,être
devoir|dois,dois,doit,devons,devez,doivent|doive,doives,doive,devions,deviez,doivent|devr|dû,avoir
plaire|plais,plais,plaît,plaisons,plaisez,plaisent|plaise,plaises,plaise,plaisions,plaisiez,plaisent|plair|plu,avoir
valoir|vaux,vaux,vaut,valons,valez,valent|vaille,vailles,vaille,valions,valiez,vaillent|vaudr|valu,avoir
falloir|faut,faut,faut,faut,faut,faut|faille,failles,faille,faillions,failliez,faillent|faudr|fallu,avoir
`;

/* être 作助动词的动词（DR & MRS VANDERTRAMP 系列） */
const ETRE_VERBS = new Set(['aller','venir','partir','arriver','entrer','sortir','monter','descendre','tomber','rester','devenir','naître','mourir','retourner','rentrer','revenir','venir','sortir','entrer','monter','tomber','naître','mourir','apparaître','partir','arriver']);

/* ---------- 4. 中文母语者法语易错点库（负迁移） ---------- */
const SLA_LIB = [
  { id:'genre', name:'名词阴阳性混淆', level:'A1',
    why:'中文没有性的范畴，中国学生最容易在这里丢分。',
    wrong:'le maison / la problème', right:'la maison / le problème',
    tip:'不要靠词尾猜。背单词时必须连着冠词背：la maison，不是 maison。词尾 -tion / -té / -sie / -esse / -ure 多为阴性；-ment / -isme / -eau / -oir / -age 多为阳性。' },
  { id:'accord', name:'形容词 / 过去分词性数配合', level:'A2',
    why:'中文形容词不变化，"美丽的女孩"没有任何标记，学生大脑里没有"配合"这个自动流程。',
    wrong:'une fille intelligent / elle est allé à Paris', right:'une fille intelligente / elle est allée à Paris',
    tip:'凡是女性名词（含复数）前，形容词一律加 -e / -es。用 être 构成的复合过去时，过去分词要和主语配合；用 avoir 时，只有当直接宾语提前才配合。' },
  { id:'subj', name:'虚拟式该用不敢用', level:'B1',
    why:'中文没有语气系统，"我希望他去"没有动词变形，学生本能地用直陈式。',
    wrong:'Il faut que tu es à l’heure.', right:'Il faut que tu sois à l’heure.',
    tip:'强制触发虚拟式的主句：il faut que / vouloir que / aimer que / bien que / avant que / pour que / à moins que。见到 que 就停一秒，判断要不要变虚拟。' },
  { id:'pron', name:'宾语代词位置放错', level:'B1',
    why:'中文代词位置和法语完全不同（"我把它给他" vs Je le lui donne）。',
    wrong:'Je donne lui le livre. / Je le mange pas.', right:'Je lui donne le livre. / Je ne le mange pas.',
    tip:'代词永远贴在变位动词前面；有原形动词时贴在原形动词前面。有多个代词时顺序：me/te/se/nous/vous → le/la/les → lui/leur → y → en。' },
  { id:'articles', name:'部分冠词 vs 定冠词', level:'A2',
    why:'中文没有冠词系统，"我喜欢咖啡"和"我喝了咖啡"在中文里一样，法语却完全不同。',
    wrong:'Je bois le café tous les jours.（表习惯）', right:'Je bois du café tous les jours.',
    tip:'表泛指 / 部分（"一些"）用 du / de la / des；表整体偏好或特指用 le / la / les。完全否定和数量副词后一律变 de。' },
  { id:'aux', name:'复合过去时助动词选 être 还是 avoir', level:'A1',
    why:'中国学生默认全用 avoir。',
    wrong:'Je suis mangé une pomme. / Il a allé au cinéma.', right:'J’ai mangé une pomme. / Il est allé au cinéma.',
    tip:'只有十余个动词（加上全部代词式动词）用 être 作助动词：aller venir partir arriver entrer sortir monter descendre tomber rester devenir naître mourir 等。其余全部 avoir。' },
  { id:'neg', name:'ne 的省略与位置', level:'A2',
    why:'口语里法国人几乎不说 ne，学生照着听力材料学，写 DELF 作文时就丢了分。',
    wrong:'J’ai pas compris. （书面）', right:'Je n’ai pas compris. / Je n’ai rien vu.',
    tip:'DELF/DALF 书面表达务必写完整的 ne ... pas/jamais/rien/plus/personne。ne 紧跟主语代词，pas 包住变位动词。' },
  { id:'de', name:'de + le → du 的缩合', level:'A1',
    why:'中文没有缩合概念。',
    wrong:'J’ai besoin de le temps. / près de les arbres', right:'J’ai besoin du temps. / près des arbres',
    tip:'de + le = du，de + les = des，à + le = au，à + les = aux。de 和 les、le 永远不能直接连写。' },
  { id:'accent', name:'音符（é è ê à ù ç ô î）缺失', level:'A1',
    why:'中文输入法打法语非常痛苦，学生习惯性省掉音符，DELF 阅卷会算拼写错误。',
    wrong:'etre / ete / a cote', right:'être / été / à côté',
    tip:'开一套法语键盘（macOS 用 ABC Extended，Windows 用 CAN 或国际键盘），或者在输入法里做自定义短语。é=e+Alt, è=e+` , ç 用 dead key。' },
  { id:'en_y', name:'y 和 en 的遗漏', level:'B1',
    why:'中文代词"在那里 / 一些"有时可以省略，法语必须补出。',
    wrong:'Je vais à Paris.（回答 Tu vas à Paris ?）', right:'Oui, j’y vais. / J’en ai trois.',
    tip:'代替 à + 地点 用 y；代替 de + 名词或部分数量用 en。两者都放在动词前。' },
  { id:'imparfait', name:'未完成过去时 vs 复合过去时', level:'A2',
    why:'中文动词没有时间体态，讲过去的事情全用"了"。',
    wrong:'Quand j’ai eu dix ans, je suis allé souvent chez ma grand-mère.', right:'Quand j’avais dix ans, j’allais souvent chez ma grand-mère.',
    tip:'未完成过去时 = 背景、习惯、持续状态；复合过去时 = 具体完成的动作。叙事时先用未完成打背景，再用复合过去讲事件。' },
  { id:'que_qui', name:'关系代词 que / qui / dont / où', level:'B1',
    why:'中文定语从句用"的"一把梭，法语要按从句内部缺什么成分来选。',
    wrong:'La femme que habite ici. / Le livre que je parle.', right:'La femme qui habite ici. / Le livre dont je parle.',
    tip:'缺主语 → qui；缺直接宾语 → que；缺 de + 名词 → dont；缺地点/时间状语 → où。' }
];
