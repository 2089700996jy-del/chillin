/** Mutable app state shared across modules. */
import { getEast8Time } from './utils.js';

export const DEFAULT_WEEKLY = [{
    id: 1, category: "馃尭", title: "2023-W42: 璁板繂鍒囩墖",
    summary: "鍦ㄨ繖涓妭濂忔瀬蹇殑绉嬪懆閲岋紝鎶撲綇浜嗕竴浜涘井灏忕殑纭垢锛氶粦濉炪€佸潅鏈緳涓€銆佸拰涓€纰楀畬缇庣殑鎰忛潰銆?,
    date: "2023骞?0鏈?2鏃?,
    cover: "https://images.unsplash.com/photo-1505909182942-e2f09aee3e89?q=80&w=800&auto=format&fit=crop",
    weeklyData: {
        music: { title: "Merry Christmas Mr. Lawrence", artist: "鍧傛湰榫欎竴", lyric: "鏃犻渶姝岃瘝锛屽敮鏈夊畞闈欒法瓒婃椂闂淬€? },
        media: [{ icon: "馃幀", title: "銆婂ゥ鏈捣榛樸€?, desc: "鍦?IMAX 鍘呮劅鍙椾簡鏋佸叾闇囨捈鐨勯煶鏁堜笌浜虹被缇ゆ槦闂€€鐨勭煕鐩俱€? }],
        life: { image: "https://images.unsplash.com/photo-1473093295043-cdd812d0e601?q=80&w=600&auto=format&fit=crop", caption: "鍛ㄤ簲鏅氫笂鐨勫畬缇庢剰闈?馃崫" },
        podcast: "鍦ㄣ€奌uberman Lab銆嬮噷瀛﹀埌浜嗭紝鏃╂櫒閱掓潵鍚庝笉瑕佺珛鍒荤湅鎵嬫満锛岃€屾槸鍏堝幓鎺ヨЕ鑷劧鍏?10 鍒嗛挓锛岃兘澶熷畬缇庨噸缃樇澶滆妭寰嬨€?,
        work: { title: "Next.js App Router 杩佺Щ", desc: "鏈懆韪╁畬浜?Server Actions 鐨勫潙銆傜粨璁猴細灏嗗鏉傜殑鏁版嵁楠岃瘉閫昏緫鍏ㄩ儴绉诲埌鍗曠嫭鐨?API 璺敱銆? }
    },
    content: "<p>鏃堕棿鐨勬祦閫濆湪寮€濮嬪伐浣滃悗鍙樺緱鎯婁汉鐨勫揩銆傚懆涓€鍒板懆浜斾豢浣涜鍘嬬缉鎴愪簡涓€澶┿€傛墍浠ュ喅瀹氱敤杩欐牱鐨勬柟寮忥紝鎶婃瘡鍛ㄥ€煎緱璁颁綇鐨勬椂鍒诲垏鐗囦繚瀛樹笅鏉ャ€?/p>"
}];

export const DEFAULT_NOTES = [
    { id: 101, title: "涓嬪懆璐墿娓呭崟", content: "1. 鍜栧暋璞哱n2. 鍏ㄨ剛鐗涘ザ\n3. 鏋佺畝椋庨┈鍏嬫澂\n4. 缁挎锛堥緹鑳岀锛?, date: "2023骞?0鏈?3鏃? },
    { id: 102, title: "闆剁鐏垫劅", content: "涔熻鍙互灏濊瘯缁欏崥瀹㈠姞涓婃繁鑹叉ā寮忥紵\n棰滆壊鏂规鍙互鍙傝€?GitHub 鐨?Dark Dimmed銆?, date: "2023骞?0鏈?4鏃? }
];

export const DEFAULT_BOOKMARKS = [
    { id: 201, type: "馃洜锔?宸ュ叿", title: "Notion", url: "https://notion.so", desc: "鏋佽嚧鐨勫潡鐘剁紪杈戝櫒锛岀伒鎰熺殑鍙戞簮鍦般€?, image: "" },
    { id: 202, type: "馃寪 缃戠珯", title: "Vercel", url: "https://vercel.com", desc: "鍓嶇椤圭洰涓€閿儴缃茬殑绁炰粰骞冲彴銆? },
    { id: 203, type: "馃幀 鐢靛奖", title: "璞嗙摚鐢靛奖", url: "https://movie.douban.com", desc: "鎵惧喎闂ㄥソ鐗囩殑鍞竴鍘诲銆? }
];

export const DEFAULT_FEEDS = [
    {
        id: 1,
        content: "浠婂ぉ灏嗘暟瀛楄姳鍥崌绾ф帴鍏ヤ簡 AI 璁板繂鑳藉姏涓庨殢鎵嬭娴侊紒鍙互闅忔椂鍦ㄩ《閮ㄥ€惧€掓€濊€冿紝AI 涔熶細瀹炴椂鎹曟崏鑴夌粶銆?,
        type: "text",
        tags: ["#鎶€鏈?, "#鐏垫劅"],
        created_at: getEast8Time().slice(0, 16)
    }
];

export const state = {
    authToken: localStorage.getItem('chillin_token') || '',
    authUser: JSON.parse(localStorage.getItem('chillin_user') || 'null'),
    database: [],
    notesDatabase: [],
    bookmarksDatabase: [],
    feedsDatabase: [],
    echoCardsDatabase: [],
    aiChatHistory: [],
    isRegisterMode: false,
};
