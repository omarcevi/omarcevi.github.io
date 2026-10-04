"""Compute the real model data behind the interactive figures on omarcevi.dev.

Runs GPT-2 small (124M, the ONNX export from github.com/onnx/models) on text
taken straight from index.html and writes:

  assets/ml/hero.json        next-token predictions for the name + tagline
                             (teacher-forced: what GPT-2 expected at every step
                             vs. the token that is actually there)
  assets/ml/attention.json   word list + per-head stats for the About text
  assets/ml/attention.bin    top-k word-to-word attention weights for every
                             layer and head (+ a per-layer head average)

Nothing on the page is hand-tuned: change the About text or the tagline, run
this again (or let .github/workflows/ml-figures.yml do it) and the figures
follow.

    pip install -r scripts/requirements.txt
    python scripts/ml_figures.py
"""
import argparse
import hashlib
import html
import json
import re
import sys
import urllib.request
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from gpt2_bpe import Encoder  # noqa: E402

MODEL_URL = ("https://media.githubusercontent.com/media/onnx/models/main/validated/text/"
             "machine_comprehension/gpt-2/model/gpt2-lm-head-10.onnx")
VOCAB_URLS = {
    "encoder.json": "https://raw.githubusercontent.com/latitudegames/GPT-3-Encoder/master/encoder.json",
    "vocab.bpe": "https://raw.githubusercontent.com/latitudegames/GPT-3-Encoder/master/vocab.bpe",
}
EOT = 50256          # <|endoftext|>, used as BOS so the attention sink lands on it
TOP_K_ATTN = 6       # attention targets kept per word, per head
TOP_K_HERO = 3       # candidate tokens shown per step


# ---------------------------------------------------------------- inputs ----
def strip_tags(s):
    return html.unescape(re.sub(r"<[^>]+>", "", s))


def read_page(index_path):
    page = index_path.read_text(encoding="utf-8")
    name = re.search(r'<h1 id="name"[^>]*>(.*?)</h1>', page, re.S).group(1)
    em = re.search(r"<em>(.*?)</em>", name, re.S)
    tag = re.search(r'<p id="tagline"[^>]*>(.*?)</p>', page, re.S).group(1)
    strong = re.search(r"<strong>(.*?)</strong>", tag, re.S)
    about = re.search(r'<div class="about-body[^"]*">(.*?)</div>', page, re.S).group(1)
    paras = [" ".join(strip_tags(p).split()) for p in re.findall(r"<p>(.*?)</p>", about, re.S)]
    return {
        "name": " ".join(strip_tags(name).split()),
        "name_em": " ".join(strip_tags(em.group(1)).split()) if em else "",
        "tagline": " ".join(strip_tags(tag).split()),
        "tagline_strong": " ".join(strip_tags(strong.group(1)).split()) if strong else "",
        "about": paras,
    }


# ----------------------------------------------------------------- model ----
def fetch(url, dest):
    if dest.exists():
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"downloading {url}", file=sys.stderr)
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(url) as r, open(tmp, "wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    tmp.rename(dest)
    return dest


def load_model(cache):
    import onnx
    import onnxruntime as ort

    raw = fetch(MODEL_URL, cache / "gpt2-lm-head-10.onnx")
    patched = cache / "gpt2-lm-head-10.attn.onnx"
    if not patched.exists():
        # expose every attention softmax (one per layer) as an extra graph output
        m = onnx.load(str(raw))
        for n in m.graph.node:
            if n.op_type == "Softmax":
                m.graph.output.append(onnx.helper.make_tensor_value_info(n.output[0], onnx.TensorProto.FLOAT, None))
        onnx.save(m, str(patched))
    sess = ort.InferenceSession(str(patched), providers=["CPUExecutionProvider"])
    outs = [o.name for o in sess.get_outputs()]
    m = onnx.load(str(patched), load_external_data=False)
    softmax_outs = [n.output[0] for n in m.graph.node if n.op_type == "Softmax"]
    enc = Encoder(fetch(VOCAB_URLS["encoder.json"], cache / "encoder.json"),
                  fetch(VOCAB_URLS["vocab.bpe"], cache / "vocab.bpe"))
    return sess, outs, softmax_outs, enc


def run(sess, outs, softmax_outs, ids):
    res = sess.run(None, {"input1": np.array([[ids]], dtype=np.int64)})
    logits = res[0][0, 0]                                       # [T, vocab]
    attn = np.stack([res[outs.index(n)][0] for n in softmax_outs])  # [layers, heads, T, T]
    return logits, attn


def softmax(x):
    x = x - x.max(-1, keepdims=True)
    e = np.exp(x)
    return e / e.sum(-1, keepdims=True)


def show(b):
    """Readable label for a token's bytes (partial UTF-8 shown as <0x..>)."""
    try:
        return b.decode("utf-8")
    except UnicodeDecodeError:
        return "".join(f"<0x{x:02X}>" for x in b)


# ------------------------------------------------------------------ hero ----
def hero(sess, outs, softmax_outs, enc, page):
    text = page["name"] + "\n" + page["tagline"]
    ids = enc.encode(text)
    logits, _ = run(sess, outs, softmax_outs, [EOT] + ids)
    probs = softmax(logits.astype(np.float64))

    steps, buf, buf_p, start, pos = [], b"", 1.0, 0, 0
    nll = []
    for i, tid in enumerate(ids):
        p = probs[i]                                   # prediction for token i (after EOT + ids[:i])
        nll.append(-np.log2(p[tid]))
        if not buf:
            first_p, first_i = p, tid
        buf += enc.token_bytes(tid)
        buf_p *= float(p[tid])
        try:
            piece = buf.decode("utf-8")
        except UnicodeDecodeError:
            continue                                   # multi-token character: wait for the rest
        order = np.argsort(-first_p)
        cands = [[show(enc.token_bytes(int(c))), round(float(first_p[c]), 4)] for c in order[:TOP_K_HERO]]
        rank = int(np.where(order == first_i)[0][0]) + 1
        steps.append({"t": piece, "s": pos, "p": round(buf_p, 5), "rank": rank, "cands": cands})
        pos += len(piece)
        buf, buf_p = b"", 1.0

    name_len = len(page["name"])
    em_at = page["name"].rfind(page["name_em"]) if page["name_em"] else -1
    tag_at = name_len + 1
    st = page["tagline"].find(page["tagline_strong"]) if page["tagline_strong"] else -1
    tag_ids = len(enc.encode(page["tagline"]))
    return {
        "model": "GPT-2 small (124M)",
        "text": text,
        "ranges": {
            "name": [0, name_len],
            "name_em": [em_at, em_at + len(page["name_em"])] if em_at >= 0 else None,
            "tagline": [tag_at, tag_at + len(page["tagline"])],
            "tagline_strong": [tag_at + st, tag_at + st + len(page["tagline_strong"])] if st >= 0 else None,
        },
        "steps": steps,
        "tokens": len(ids),
        "perplexity": round(float(2 ** np.mean(nll)), 1),
        "tagline_perplexity": round(float(2 ** np.mean(nll[-tag_ids:])), 1),
    }


# ------------------------------------------------------------- attention ----
def attention(sess, outs, softmax_outs, enc, page):
    paras = page["about"]
    text = "\n\n".join(paras)
    data = text.encode("utf-8")

    # words exactly as the page splits them (whitespace), with byte spans
    words, word_para = [], []
    off = 0
    for pi, p in enumerate(paras):
        for m in re.finditer(r"\S+", p):
            b0 = len(text[:off + m.start()].encode("utf-8"))
            b1 = len(text[:off + m.end()].encode("utf-8"))
            words.append((m.group(0), b0, b1))
            word_para.append(pi)
        off += len(p) + 2

    ids = enc.encode(text)
    assert enc.decode(ids) == text
    tok_word, b = [], 0
    for tid in ids:
        tb = enc.token_bytes(tid)
        s, e = b, b + len(tb)
        b = e
        w = next((wi for wi, (_, w0, w1) in enumerate(words) if s < w1 and e > w0 and data[max(s, w0):min(e, w1)].strip()), -1)
        tok_word.append(w)
    tok_word = np.array(tok_word)

    _, attn = run(sess, outs, softmax_outs, [EOT] + ids)  # [L, H, T+1, T+1]
    L, H = attn.shape[:2]
    bos_share = attn[:, :, 1:, 0].mean(-1)               # how much each head parks on <|endoftext|>
    a = attn[:, :, 1:, 1:]                               # drop BOS row/column ...
    a = a / np.clip(a.sum(-1, keepdims=True), 1e-9, None)  # ... and renormalise the rest

    W = len(words)
    # token -> word pooling: average over query tokens, sum over key tokens
    Q = np.zeros((W, len(ids)))
    K = np.zeros((len(ids), W))
    for t, w in enumerate(tok_word):
        if w >= 0:
            K[t, w] = 1
    for w in range(W):
        mask = tok_word == w
        Q[w, mask] = 1 / mask.sum()
    aw = np.einsum("wt,lhts,sv->lhwv", Q, a, K)          # [L, H, W, W]
    aw = np.concatenate([aw, aw.mean(1, keepdims=True)], axis=1)  # + per-layer head average

    dist = np.abs(np.arange(W)[:, None] - np.arange(W)[None, :])
    mean_dist = (aw[:, :H] * dist).sum(-1).mean(-1)      # [L, H] average distance attended, in words

    idx_dtype = np.uint8 if W <= 255 else np.uint16
    eye = np.eye(W, dtype=bool)
    masked = np.where(eye, -1, aw)                       # skip self when ranking
    top = np.argsort(-masked, axis=-1)[..., :TOP_K_ATTN]
    vals = np.take_along_axis(aw, top, axis=-1)
    vals = np.where(np.take_along_axis(masked, top, axis=-1) < 0, 0, vals)
    q = np.round(np.clip(vals, 0, 1) * 255).astype(np.uint8)

    # a readable default: the head whose strongest link per word most often skips
    # past its neighbours (i.e. looks like it is matching meaning, not position)
    far = np.abs(top[:, :H] - np.arange(W)[None, None, :, None]) >= 2
    score = (vals[:, :H] * far).max(-1)[:, :, min(10, W - 1):].mean(-1)
    dl, dh = np.unravel_index(np.argmax(score), score.shape)

    meta = {
        "model": "GPT-2 small (124M)",
        "layers": int(L), "heads": int(H), "words": [w for w, _, _ in words], "para": word_para,
        "k": TOP_K_ATTN, "idx_bytes": int(np.dtype(idx_dtype).itemsize),
        "layout": "idx[L][H+1][W][k] then weight_u8[L][H+1][W][k]; head index H = mean over heads",
        "bos_share": np.round(bos_share, 3).tolist(),
        "mean_dist": np.round(mean_dist, 2).tolist(),
        "default": [int(dl), int(dh)],
        "tokens": len(ids),
    }
    blob = top.astype(idx_dtype).tobytes() + q.tobytes()
    return meta, blob


# ------------------------------------------------------------------ main ----
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--index", default=str(ROOT / "index.html"))
    ap.add_argument("--out", default=str(ROOT / "assets" / "ml"))
    ap.add_argument("--cache", default=str(Path.home() / ".cache" / "omarcevi-ml"))
    ap.add_argument("--default-head", help="override the default head, e.g. 5.1 (layer.head, 0-based)")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    page = read_page(Path(args.index))
    out = Path(args.out)
    digest = hashlib.sha256(json.dumps(page, sort_keys=True).encode()).hexdigest()[:16]
    stamp = out / "source.sha"
    if not args.force and stamp.exists() and stamp.read_text().strip() == digest + (args.default_head or ""):
        print("text unchanged, nothing to do")
        return

    sess, outs, softmax_outs, enc = load_model(Path(args.cache))
    out.mkdir(parents=True, exist_ok=True)

    h = hero(sess, outs, softmax_outs, enc, page)
    (out / "hero.json").write_text(json.dumps(h, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    meta, blob = attention(sess, outs, softmax_outs, enc, page)
    if args.default_head:
        l, hd = map(int, args.default_head.split("."))
        meta["default"] = [l, hd]
    (out / "attention.json").write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (out / "attention.bin").write_bytes(blob)
    stamp.write_text(digest + (args.default_head or ""))

    print(f"hero: {h['tokens']} tokens, perplexity {h['perplexity']}")
    print(f"attention: {len(meta['words'])} words, {meta['tokens']} tokens, default head L{meta['default'][0]}H{meta['default'][1]}, "
          f"{len(blob) / 1024:.0f} KB")


if __name__ == "__main__":
    main()
