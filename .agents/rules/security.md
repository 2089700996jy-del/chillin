# 数据安全与防御式编程规范 (Security Rule)

> 本规范约束 Chillin 项目在数据加密、身份鉴权、文件上传、网络请求及富文本渲染层面的安全防线。

---

## 1. 身份认证与密码加密防线

1. **PBKDF2 强哈希算法**：
   * 用户密码必须使用标准 PBKDF2（100,000 次迭代，SHA-256 算法，配合 16 字节独立随机 Salt）；
   * 严禁明文存储密码，严禁使用 MD5、SHA-1 或单次 SHA-256 等不安全哈希。
2. **时序安全比对 (Timing-Safe Compare)**：
   * Session Token、认证密钥或哈希值的比较必须调用 `timingSafeEqualStr` 进行恒定时间逐字节异或比对；
   * **绝对严禁直接使用 JavaScript 的 `===` 运算符进行密码或 Token 比对**，彻底杜绝基于时序分析的侧信道攻击 (Side-Channel Timing Attack)。

---

## 2. 文件上传与二进制魔数防线

1. **二进制魔数严格嗅探 (Magic-Byte Sniffing)**：
   * 接受任何客户端上传的图片附件前，后端必须在内存中读取前几个字节的二进制魔数：
     * **PNG**: `89 50 4E 47 0D 0A 1A 0A`
     * **JPEG**: `FF D8 FF`
     * **GIF**: `47 49 46 38`
     * **WebP**: `52 49 46 46` ... `57 45 42 50`
   * 坚决拦截利用文件后缀名欺骗上传可执行脚本、SVG 跨站脚本或 Polyglot 恶意载荷的行为。

---

## 3. 服务端请求伪造 (SSRF) 规范 —— 已随功能移除

> 本节原先约束「外链预览抓取」的出站校验（14 组私网/元数据网段、IPv6 内嵌 IPv4、FQDN 尾点归一化等）。
> v2.5.97 已整体删除外链解析功能，相关实现（`security-ssrf.js`：`isSafeFetchUrl` / `isLoopbackOrPrivateHost` / 十四组 CIDR 判定 / `readTextCapped` / `fetchWithTimeout` / 违规域名黑名单）与对应测试一并移除。
> **若将来重新引入任何服务端出站抓取，必须恢复这套校验**（历史实现可从 git 历史取回）。
## 4. 前端防存储型 XSS (DOMPurify 过滤)

1. **富文本注入白名单**：
   * 任何来自用户输入、外链提取或数据库持久化文本在通过 `innerHTML` 渲染前，必须经过 `DOMPurify.sanitize()` 进行白名单过滤清洗；
   * 避免用户或第三方外链注入 `<script>`、`onload`、`javascript:` 等恶意代码。
