//! Search core for the VS Code search panel extension.
//!
//! Compiled to `wasm32-unknown-unknown` and loaded from the extension host with
//! raw `WebAssembly.instantiate`. No wasm-bindgen, no JS glue: the module exports
//! a small C ABI and the host reads/writes linear memory directly.

use fancy_regex::{Captures, Regex, RegexBuilder};
use std::cell::RefCell;

const FLAG_IGNORE_CASE: u32 = 1 << 0;
const FLAG_MULTILINE: u32 = 1 << 1;
const FLAG_DOTALL: u32 = 1 << 2;
const FLAG_WHOLE_WORD: u32 = 1 << 3;

const MODE_EXTENDED: u32 = 1;
const MODE_REGEX: u32 = 2;

thread_local! {
    static REGEXES: RefCell<Vec<Option<Regex>>> = RefCell::new(Vec::new());
    static LAST_ERROR: RefCell<String> = RefCell::new(String::new());
}

fn set_error(msg: impl Into<String>) {
    LAST_ERROR.with(|e| *e.borrow_mut() = msg.into());
}

fn clear_error() {
    LAST_ERROR.with(|e| e.borrow_mut().clear());
}

// ------------------------------------------------------------- memory plumbing

/// Allocates `len` bytes the host can write into. Freed with [`dealloc`].
#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut buf: Vec<u8> = Vec::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// Frees any buffer handed to the host, including `find_all` / `replace_all`
/// results. `len` must be the exact byte length of the buffer.
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    if ptr.is_null() {
        return;
    }
    let _ = Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len));
}

fn leak_bytes(bytes: Vec<u8>) -> *mut u8 {
    let mut boxed = bytes.into_boxed_slice();
    let ptr = boxed.as_mut_ptr();
    std::mem::forget(boxed);
    ptr
}

unsafe fn slice_str<'a>(ptr: *const u8, len: usize) -> Result<&'a str, String> {
    if len == 0 {
        return Ok("");
    }
    let bytes = std::slice::from_raw_parts(ptr, len);
    std::str::from_utf8(bytes).map_err(|e| format!("文本不是合法 UTF-8：{}", e))
}

// ---------------------------------------------------------------- pattern prep

fn escape_literal(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        if "\\^$.|?*+()[]{}".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

fn hex_val(c: char) -> Option<u32> {
    c.to_digit(16)
}

fn expand_extended(pattern: &str) -> String {
    let chars: Vec<char> = pattern.chars().collect();
    let mut out = String::with_capacity(pattern.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c != '\\' {
            out.push(c);
            i += 1;
            continue;
        }
        if i + 1 >= chars.len() {
            out.push('\\');
            break;
        }
        let next = chars[i + 1];
        match next {
            'n' => {
                out.push('\n');
                i += 2;
            }
            'r' => {
                out.push('\r');
                i += 2;
            }
            't' => {
                out.push('\t');
                i += 2;
            }
            '0' => {
                out.push('\0');
                i += 2;
            }
            '\\' => {
                out.push('\\');
                i += 2;
            }
            'x' | 'u' => {
                let want = if next == 'x' { 2 } else { 4 };
                let mut value = 0u32;
                let mut consumed = 0;
                for k in 0..want {
                    match chars.get(i + 2 + k).and_then(|c| hex_val(*c)) {
                        Some(d) => {
                            value = value * 16 + d;
                            consumed += 1;
                        }
                        None => break,
                    }
                }
                if consumed == want {
                    out.push(char::from_u32(value).unwrap_or('\u{fffd}'));
                } else {
                    out.push('\\');
                    out.push(next);
                }
                i += 2 + consumed;
            }
            other => {
                out.push('\\');
                out.push(other);
                i += 2;
            }
        }
    }
    out
}

/// Rewrites the Boost/PCRE constructs that fancy-regex cannot compile into
/// equivalents it can, and refuses the ones with no honest translation.
fn rewrite_regex(pattern: &str) -> Result<String, String> {
    let chars: Vec<char> = pattern.chars().collect();
    let mut out = String::with_capacity(pattern.len() + 16);
    let mut i = 0;
    let mut in_class = false;

    while i < chars.len() {
        let c = chars[i];

        if in_class {
            if c == '\\' && i + 1 < chars.len() {
                out.push(c);
                out.push(chars[i + 1]);
                i += 2;
                continue;
            }
            if c == ']' {
                in_class = false;
            }
            out.push(c);
            i += 1;
            continue;
        }

        if c == '[' {
            in_class = true;
            out.push(c);
            i += 1;
            continue;
        }

        if c == '\\' && i + 1 < chars.len() {
            match chars[i + 1] {
                'K' => {
                    return Err("\\K（丢弃已匹配前缀）不被当前引擎支持。可改用捕获组，例如把 (a+)\\Kb 写成 a+(b)。".into());
                }
                'G' => {
                    return Err("\\G（锚定上次匹配位置）不被当前引擎支持，请改用 \\A 或去掉该断言。".into());
                }
                'X' => {
                    return Err("\\X（字形簇）不被当前引擎支持，请改用 . 或显式字符类。".into());
                }
                'Q' => {
                    let mut j = i + 2;
                    let mut literal = String::new();
                    while j < chars.len() {
                        if chars[j] == '\\' && chars.get(j + 1) == Some(&'E') {
                            break;
                        }
                        literal.push(chars[j]);
                        j += 1;
                    }
                    out.push_str(&escape_literal(&literal));
                    i = if j < chars.len() { j + 2 } else { j };
                    continue;
                }
                'h' => {
                    out.push_str("[ \\t\\u{a0}]");
                    i += 2;
                    continue;
                }
                'R' => {
                    out.push_str("(?:\\r\\n|[\\n\\r\\x0b\\x0c\\u{85}\\u{2028}\\u{2029}])");
                    i += 2;
                    continue;
                }
                other => {
                    out.push('\\');
                    out.push(other);
                    i += 2;
                    continue;
                }
            }
        }

        if c == '+' && chars.get(i + 1) == Some(&'+') {
            return Err("占有量词 a++ 不被当前引擎支持，请改用贪婪量词 a+。".into());
        }
        if (c == '*' || c == '?' || c == '}') && chars.get(i + 1) == Some(&'+') {
            return Err("占有量词不被当前引擎支持，请改用贪婪量词。".into());
        }
        if c == '(' && chars.get(i + 1) == Some(&'?') && chars.get(i + 2) == Some(&'>') {
            return Err("原子组 (?>...) 不被当前引擎支持，可用 (?=(?:...)) 前方断言近似替代。".into());
        }
        if c == '(' && chars.get(i + 1) == Some(&'?') && chars.get(i + 2) == Some(&'(') {
            return Err("条件组 (?(1)...) 不被当前引擎支持，请拆成两条搜索。".into());
        }
        if c == '(' && chars.get(i + 1) == Some(&'?') && chars.get(i + 2) == Some(&'R') {
            return Err("递归 (?R) 不被当前引擎支持。".into());
        }

        out.push(c);
        i += 1;
    }

    Ok(out)
}

fn build_source(pattern: &str, mode: u32, flags: u32) -> Result<String, String> {
    let base = match mode {
        MODE_EXTENDED => escape_literal(&expand_extended(pattern)),
        MODE_REGEX => rewrite_regex(pattern)?,
        _ => escape_literal(pattern),
    };

    if flags & FLAG_WHOLE_WORD != 0 {
        // ASCII word boundaries (the classic editors default) rather than the
        // Unicode-aware \b of the Rust engine.
        Ok(format!("(?<![0-9A-Za-z_])(?:{})(?![0-9A-Za-z_])", base))
    } else {
        Ok(base)
    }
}

// --------------------------------------------------------------------- exports

#[no_mangle]
pub unsafe extern "C" fn compile(
    pat_ptr: *const u8,
    pat_len: usize,
    mode: u32,
    flags: u32,
    backtrack_limit: u32,
) -> i32 {
    clear_error();
    let pattern = match slice_str(pat_ptr, pat_len) {
        Ok(s) => s,
        Err(e) => {
            set_error(e);
            return 0;
        }
    };
    if pattern.is_empty() {
        set_error("查找内容为空");
        return 0;
    }

    let source = match build_source(pattern, mode, flags) {
        Ok(s) => s,
        Err(e) => {
            set_error(e);
            return 0;
        }
    };

    let limit = if backtrack_limit == 0 {
        usize::MAX
    } else {
        backtrack_limit as usize
    };

    let mut builder = RegexBuilder::new(&source);
    builder
        .case_insensitive(flags & FLAG_IGNORE_CASE != 0)
        .multi_line(flags & FLAG_MULTILINE != 0)
        .dot_matches_new_line(flags & FLAG_DOTALL != 0)
        .backtrack_limit(limit);
    let built = builder.build();

    match built {
        Ok(re) => REGEXES.with(|r| {
            let mut list = r.borrow_mut();
            // Handles are only ever used by the search that compiled them, so
            // trimming the registry keeps wasm memory flat over long sessions.
            if list.len() >= 64 {
                list.clear();
            }
            list.push(Some(re));
            list.len() as i32
        }),
        Err(e) => {
            let hint = match mode {
                MODE_REGEX => "（正则模式）",
                MODE_EXTENDED => "（扩展模式）",
                _ => "",
            };
            set_error(format!("表达式编译失败{}：{}", hint, e));
            0
        }
    }
}

/// Returns a buffer laid out as little-endian u32s:
/// `[count, start0, len0, start1, len1, ...]`, offsets in UTF-8 bytes.
#[no_mangle]
pub unsafe extern "C" fn find_all(
    handle: i32,
    text_ptr: *const u8,
    text_len: usize,
    limit: u32,
) -> *mut u8 {
    clear_error();
    let text = match slice_str(text_ptr, text_len) {
        Ok(s) => s,
        Err(e) => {
            set_error(e);
            return std::ptr::null_mut();
        }
    };

    let mut pairs: Vec<u32> = Vec::with_capacity(64);
    let result = REGEXES.with(|r| {
        let list = r.borrow();
        let re = match list.get(handle as usize - 1).and_then(|o| o.as_ref()) {
            Some(re) => re,
            None => return Err("无效的表达式句柄".to_string()),
        };
        let mut count: u32 = 0;
        for item in re.find_iter(text) {
            match item {
                Ok(m) => {
                    pairs.push(m.start() as u32);
                    pairs.push((m.end() - m.start()) as u32);
                    count += 1;
                    if limit != 0 && count >= limit {
                        break;
                    }
                }
                Err(e) => return Err(e.to_string()),
            }
        }
        Ok(count)
    });

    match result {
        Ok(count) => {
            let mut out: Vec<u8> = Vec::with_capacity(4 + pairs.len() * 4);
            out.extend_from_slice(&count.to_le_bytes());
            for v in pairs {
                out.extend_from_slice(&v.to_le_bytes());
            }
            leak_bytes(out)
        }
        Err(e) => {
            set_error(e);
            std::ptr::null_mut()
        }
    }
}

/// Validates that a byte range is well-formed UTF-8. Returns 1 for valid,
/// 0 for invalid. Runs on the scratch copy already placed in linear memory
/// (putBytes), so the JS side no longer pays a full TextDecoder pass just
/// to classify a file — this replaces the old `utf8Strict.decode(body)` scan.
///
/// ASCII fast path: source files are overwhelmingly bytes < 0x80, so step 8
/// bytes at a time and only hand the tail to the real DFA validator. The
/// prefix is all-ASCII by construction, so no multi-byte sequence can span
/// the boundary and validating the suffix alone is sound.
#[no_mangle]
pub unsafe extern "C" fn utf8_valid(ptr: *const u8, len: usize) -> u32 {
    if len == 0 {
        return 1;
    }
    let bytes = std::slice::from_raw_parts(ptr, len);
    let mut i = 0usize;
    while i + 8 <= len {
        let mut chunk = [0u8; 8];
        chunk.copy_from_slice(&bytes[i..i + 8]);
        if u64::from_le_bytes(chunk) & 0x8080_8080_8080_8080 != 0 {
            break;
        }
        i += 8;
    }
    match core::str::from_utf8(&bytes[i..]) {
        Ok(_) => 1,
        Err(_) => 0,
    }
}

/// Returns a buffer of little-endian u32s: `[count, start0, start1, ...]`.
///
/// Line starts follow the editor's line-splitting semantics: every `\n` starts
/// a line, `\r\n` counts as one break, and a lone `\r` also starts a line
/// (VS Code treats it as an EOL; logcat-style files mix all three).
/// Operates on raw bytes — only 0x0A/0x0D matter, UTF-8 validity is irrelevant.
#[no_mangle]
pub unsafe extern "C" fn line_starts(ptr: *const u8, len: usize) -> *mut u8 {
    let bytes = if len == 0 {
        &[][..]
    } else {
        std::slice::from_raw_parts(ptr, len)
    };
    let mut starts: Vec<u32> = Vec::with_capacity(64);
    starts.push(0);
    let mut i = 0usize;
    while i < len {
        match bytes[i] {
            0x0A => {
                starts.push((i + 1) as u32);
                i += 1;
            }
            0x0D => {
                if i + 1 < len && bytes[i + 1] == 0x0A {
                    // \r\n：一个断行，下一行起点在 LF 之后
                    starts.push((i + 2) as u32);
                    i += 2;
                } else {
                    // 孤立 \r：自成一行（含文件末尾的 \r，编辑器同样补一个空行）
                    starts.push((i + 1) as u32);
                    i += 1;
                }
            }
            _ => i += 1,
        }
    }
    let mut out: Vec<u8> = Vec::with_capacity(4 + starts.len() * 4);
    out.extend_from_slice(&(starts.len() as u32).to_le_bytes());
    for v in starts {
        out.extend_from_slice(&v.to_le_bytes());
    }
    leak_bytes(out)
}

/// Number of line starts within `[0, upto)`.
///
/// Same split semantics as `line_starts` (0x0A starts a line, 0x0D 0x0A counts
/// as one break, a lone 0x0D also starts a line), but returns only the count, so
/// callers that merely need a line offset do not pay for materializing a
/// 4-byte-per-line array across the wasm boundary. Measured cost of the array
/// path is ~757 MB/s on a 4 MB block versus ~3 GB/s for matching itself, so
/// counting alone is what makes parallel chunking scale.
///
/// `upto` may be smaller than `len` (chunk owns `[0, upto)` but read `len`
/// bytes to cover matches crossing the boundary): the byte at `upto` is still
/// inspected so a `\r` sitting exactly at the cut is not mistaken for a lone CR.
#[no_mangle]
pub unsafe extern "C" fn line_count(ptr: *const u8, len: usize, upto: usize) -> u32 {
    if len == 0 {
        return 0;
    }
    let bytes = std::slice::from_raw_parts(ptr, len);
    let end = if upto < len { upto } else { len };
    if end == 0 {
        return 0;
    }
    // 只有「行首 < end」的断行才属于这半段：\n 与孤立 \r 的判定窗口都是
    // [0, end-1)——断行落在 end-1 上时行首正好是 end，属于下一块。
    let scan = end - 1;
    // 起点 0 算一个行首（与 line_starts 的 starts[0] = 0 对齐）
    let mut count: u32 = 1;
    // \n：8 字节一组用位运算筛，逐字节分支在 4MB 上只有 ~870MB/s，
    // 而这正是分块搜索每块都要付的成本
    count += count_byte_fast(&bytes[..scan], 0x0A);
    // 孤立 \r：\r\n 已经由上面的 \n 计过，这里只补「后面不是 \n」的 \r
    count += count_lone_cr(&bytes[..end], scan);
    count
}

/// 8 字节一组的字节计数：`(x - 0x01..) & !x & 0x80..` 一次筛出 8 个候选位。
#[inline]
fn count_byte_fast(bytes: &[u8], needle: u8) -> u32 {
    let pat = (needle as u64).wrapping_mul(0x0101_0101_0101_0101);
    let mut i = 0usize;
    let mut n = 0u32;
    while i + 8 <= bytes.len() {
        let mut word = [0u8; 8];
        word.copy_from_slice(&bytes[i..i + 8]);
        let x = u64::from_le_bytes(word) ^ pat;
        let z = x.wrapping_sub(0x0101_0101_0101_0101) & !x & 0x8080_8080_8080_8080;
        n += z.count_ones();
        i += 8;
    }
    while i < bytes.len() {
        if bytes[i] == needle {
            n += 1;
        }
        i += 1;
    }
    n
}

/// `\r` 后面不是 `\n` 的个数，只看 `[0, scan_end)` 内的 `\r`。
/// 文本文件里 `\r` 极少，所以候选位循环几乎不执行。
#[inline]
fn count_lone_cr(bytes: &[u8], scan_end: usize) -> u32 {
    let pat = 0x0D0D_0D0D_0D0D_0D0D;
    let mut i = 0usize;
    let mut n = 0u32;
    while i + 8 <= scan_end {
        let mut word = [0u8; 8];
        word.copy_from_slice(&bytes[i..i + 8]);
        let x = u64::from_le_bytes(word) ^ pat;
        let mut z = x.wrapping_sub(0x0101_0101_0101_0101) & !x & 0x8080_8080_8080_8080;
        while z != 0 {
            let pos = i + (z.trailing_zeros() as usize) / 8;
            if bytes[pos + 1] != 0x0A {
                n += 1;
            }
            z &= z - 1;
        }
        i += 8;
    }
    while i < scan_end {
        if bytes[i] == 0x0D && bytes[i + 1] != 0x0A {
            n += 1;
        }
        i += 1;
    }
    n
}

/// Returns a buffer of `[u32 byte_len][utf8 bytes]`.
#[no_mangle]
pub unsafe extern "C" fn replace_all(
    handle: i32,
    text_ptr: *const u8,
    text_len: usize,
    repl_ptr: *const u8,
    repl_len: usize,
    limit: u32,
) -> *mut u8 {
    clear_error();
    let text = match slice_str(text_ptr, text_len) {
        Ok(s) => s,
        Err(e) => {
            set_error(e);
            return std::ptr::null_mut();
        }
    };
    let repl = match slice_str(repl_ptr, repl_len) {
        Ok(s) => s,
        Err(e) => {
            set_error(e);
            return std::ptr::null_mut();
        }
    };

    let replaced = REGEXES.with(|r| {
        let list = r.borrow();
        let re = match list.get(handle as usize - 1).and_then(|o| o.as_ref()) {
            Some(re) => re,
            None => return Err("无效的表达式句柄".to_string()),
        };

        let mut out = String::with_capacity(text.len());
        let mut last = 0usize;
        let mut count: u32 = 0;
        for item in re.captures_iter(text) {
            let caps = match item {
                Ok(c) => c,
                Err(e) => return Err(e.to_string()),
            };
            let m = match caps.get(0) {
                Some(m) => m,
                None => continue,
            };
            out.push_str(&text[last..m.start()]);
            expand_replacement(&mut out, repl, &caps);
            last = m.end();
            count += 1;
            if limit != 0 && count >= limit {
                break;
            }
        }
        out.push_str(&text[last..]);
        Ok(out)
    });

    match replaced {
        Ok(s) => {
            let bytes = s.into_bytes();
            let mut out: Vec<u8> = Vec::with_capacity(bytes.len() + 4);
            out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
            out.extend_from_slice(&bytes);
            leak_bytes(out)
        }
        Err(e) => {
            set_error(e);
            std::ptr::null_mut()
        }
    }
}

/// Expands `replacement` for a single match at `[start, end)`, returning
/// `[u32 byte_len][utf8 bytes]`. Used by “替换” so `$1` / `\\1` expand with the
/// exact same rules as “全部替换”.
#[no_mangle]
pub unsafe extern "C" fn expand_at(
    handle: i32,
    text_ptr: *const u8,
    text_len: usize,
    start: usize,
    end: usize,
    repl_ptr: *const u8,
    repl_len: usize,
) -> *mut u8 {
    clear_error();
    let text = match slice_str(text_ptr, text_len) {
        Ok(s) => s,
        Err(e) => {
            set_error(e);
            return std::ptr::null_mut();
        }
    };
    let repl = match slice_str(repl_ptr, repl_len) {
        Ok(s) => s,
        Err(e) => {
            set_error(e);
            return std::ptr::null_mut();
        }
    };

    let expanded = REGEXES.with(|r| {
        let list = r.borrow();
        let re = match list.get(handle as usize - 1).and_then(|o| o.as_ref()) {
            Some(re) => re,
            None => return Err("无效的表达式句柄".to_string()),
        };
        match re.captures_from_pos(text, start) {
            Ok(Some(caps)) => match caps.get(0) {
                Some(m) if m.start() == start && m.end() == end => {
                    let mut out = String::new();
                    expand_replacement(&mut out, repl, &caps);
                    Ok(out)
                }
                _ => Ok(String::new()),
            },
            Ok(None) => Ok(String::new()),
            Err(e) => Err(e.to_string()),
        }
    });

    match expanded {
        Ok(s) => {
            let bytes = s.into_bytes();
            let mut out: Vec<u8> = Vec::with_capacity(bytes.len() + 4);
            out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
            out.extend_from_slice(&bytes);
            leak_bytes(out)
        }
        Err(e) => {
            set_error(e);
            std::ptr::null_mut()
        }
    }
}

fn expand_replacement(out: &mut String, repl: &str, caps: &Captures<'_, str>) {
    let chars: Vec<char> = repl.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '$' && i + 1 < chars.len() {
            if chars[i + 1] == '{' {
                if let Some(end) = (i + 2..chars.len()).find(|k| chars[*k] == '}') {
                    let key: String = chars[i + 2..end].iter().collect();
                    push_group(out, caps, &key);
                    i = end + 1;
                    continue;
                }
            }
            let start = i + 1;
            let mut end = start;
            while end < chars.len() && (chars[end].is_ascii_alphanumeric() || chars[end] == '_') {
                end += 1;
            }
            if end > start {
                let key: String = chars[start..end].iter().collect();
                push_group(out, caps, &key);
                i = end;
                continue;
            }
            out.push('$');
            i += 1;
            continue;
        }
        if c == '\\' && i + 1 < chars.len() {
            match chars[i + 1] {
                'n' => out.push('\n'),
                'r' => out.push('\r'),
                't' => out.push('\t'),
                '\\' => out.push('\\'),
                d if d.is_ascii_digit() => {
                    let key = d.to_string();
                    push_group(out, caps, &key);
                }
                other => {
                    out.push('\\');
                    out.push(other);
                }
            }
            i += 2;
            continue;
        }
        out.push(c);
        i += 1;
    }
}

fn push_group(out: &mut String, caps: &Captures<'_, str>, key: &str) {
    if key.is_empty() {
        return;
    }
    let found = if key.chars().all(|c| c.is_ascii_digit()) {
        key.parse::<usize>().ok().and_then(|idx| caps.get(idx))
    } else {
        caps.name(key)
    };
    if let Some(m) = found {
        out.push_str(m.as_str());
    }
}

#[no_mangle]
pub extern "C" fn last_error_ptr() -> *const u8 {
    LAST_ERROR.with(|e| e.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn last_error_len() -> usize {
    LAST_ERROR.with(|e| e.borrow().len())
}
