#!/usr/bin/env python3
"""Reading JavaScript with a regex, minus the two things a regex cannot do.

Two checkers stripped comments with `re.sub(r'/\\*.*?\\*/', ...)` and both were quietly wrong about
the same file: line 5 of the CRM panel holds `'https://crm.zoho.eu/*'`, and a naive strip reads that
`/*` as a comment and swallows everything up to the next `*/`. **48 of that panel's 217 function
declarations were invisible**, to `twincheck` for as long as it has existed and to `namecheck` -
which was written because five naming defects reached the user, and which was therefore not reading
a fifth of the file it exists to read. Nothing said so: both answered confidently about a file that
was not the one shipped. Same lesson as `stripNonCode()` in the Deluge scanner, and the same fix -
one left-to-right scan.

The first version of that scan was still wrong, and in a way worth recording because it looked
right: it ended a template literal at the first backtick it met, and this codebase nests them
(`${cond ? `<b>x</b>` : ''}`). The scanner then took the rest of the nested template for code, read
the next `'` as the start of a string, and desynced for hundreds of lines - so a `//` comment
carrying an apostrophe ended up inside a "string" and survived. **A template is not a string; it is
a string with holes, and each hole is code.** Hence the stack.

Comments become a space, so a token cannot be glued to its neighbour. Strings, template literals and
regex literals are kept exactly as they are: this exists to remove commentary, not to tokenize.
"""

# A `/` after one of these is a regex literal rather than a division. The usual heuristic, and it is
# allowed to be one: the only thing riding on it here is whether a `/*` opens a comment.
REGEX_AFTER = set('=(,:[!&|?{};+-*%~^<>')


def strip_js(js: str) -> str:
    out = []
    i, n = 0, len(js)
    prev = ''                  # last significant character of *code*
    stack = []                 # '`' while inside a template, '{' for each brace inside its holes
    while i < n:
        c = js[i]
        # ---- inside a template literal, outside its holes ----
        if stack and stack[-1] == '`':
            if c == '\\':
                out.append(js[i:i + 2]); i += 2; continue
            if c == '`':
                stack.pop(); out.append(c); prev = '`'; i += 1; continue
            if c == '$' and i + 1 < n and js[i + 1] == '{':
                stack.append('{'); out.append('${'); prev = '{'; i += 2; continue
            out.append(c); i += 1; continue
        # ---- ordinary code (including inside a template's hole) ----
        if c in '\'"':
            j = i + 1
            while j < n and js[j] != c:
                j += 2 if js[j] == '\\' else 1
            out.append(js[i:j + 1]); prev = c; i = j + 1; continue
        if c == '`':
            stack.append('`'); out.append(c); i += 1; continue
        if c == '{':
            if stack:
                stack.append('{')
            out.append(c); prev = '{'; i += 1; continue
        if c == '}':
            if stack and stack[-1] == '{':
                stack.pop()
            out.append(c); prev = '}'; i += 1; continue
        if c == '/' and i + 1 < n and js[i + 1] == '/':
            while i < n and js[i] != '\n':
                i += 1
            out.append(' '); continue
        if c == '/' and i + 1 < n and js[i + 1] == '*':
            k = js.find('*/', i + 2)
            i = n if k < 0 else k + 2
            out.append(' '); continue
        if c == '/' and prev in REGEX_AFTER:
            j = i + 1
            while j < n and js[j] != '/':
                if js[j] == '\\':
                    j += 2; continue
                if js[j] == '[':                      # a class may hold an unescaped /
                    while j < n and js[j] != ']':
                        j += 2 if js[j] == '\\' else 1
                j += 1
            out.append(js[i:j + 1]); prev = '/'; i = j + 1; continue
        out.append(c)
        if not c.isspace():
            prev = c
        i += 1
    return ''.join(out)
