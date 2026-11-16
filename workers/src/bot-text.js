/**
 * 把模型输出的 Markdown 转成微信纯文本可读版：微信不渲染 Markdown，
 * 直接发 `**`、`###`、表格会显得很脏。
 */
export function toClawText(raw) {
    let text = String(raw == null ? '' : raw).replace(/\r\n/g, '\n');
    text = text.replace(/```[a-z0-9_-]*\n?/gi, '').replace(/```/g, '');
    text = text.replace(/^#{1,6}\s*(.+)$/gm, '【$1】');
    text = text.replace(/^\*\*(.+?)\*\*\s*$/gm, '【$1】');
    text = text.replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/__([^_\n]+)__/g, '$1');
    text = text.replace(/(^|\s)\*([^*\n]+)\*/g, '$1$2');
    text = text.replace(/`([^`\n]+)`/g, '$1');
    text = text.replace(/^\s*[-*+]\s+/gm, '• ');
    text = text.replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, '');
    text = text.replace(/^\s*\|(.+)\|\s*$/gm, (_, row) => row.split('|').map((cell) => cell.trim()).filter(Boolean).join(' · '));
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1：$2');
    text = text.replace(/^---+$/gm, '');
    // 微信聊天气泡按真人日常打字紧凑排版：消除段落间多余的空行，多换行统一收紧为单换行
    return text.replace(/\n{2,}/g, '\n').trim();
}
