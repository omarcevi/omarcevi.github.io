"""GPT-2 byte-level BPE tokenizer (a port of OpenAI's original encoder.py).

Kept in the repo so the figure script has no tokenizer dependency.
"""
import json
from functools import lru_cache

import regex as re


@lru_cache()
def bytes_to_unicode():
    bs = list(range(ord("!"), ord("~") + 1)) + list(range(ord("¡"), ord("¬") + 1)) + list(range(ord("®"), ord("ÿ") + 1))
    cs = bs[:]
    n = 0
    for b in range(256):
        if b not in bs:
            bs.append(b)
            cs.append(256 + n)
            n += 1
    return dict(zip(bs, map(chr, cs)))


def get_pairs(word):
    return {(a, b) for a, b in zip(word, word[1:])}


class Encoder:
    def __init__(self, encoder_path, bpe_path):
        with open(encoder_path, encoding="utf-8") as f:
            self.encoder = json.load(f)
        self.decoder = {v: k for k, v in self.encoder.items()}
        with open(bpe_path, encoding="utf-8") as f:
            merges = [tuple(line.split()) for line in f.read().split("\n")[1:-1]]
        self.bpe_ranks = dict(zip(merges, range(len(merges))))
        self.byte_encoder = bytes_to_unicode()
        self.byte_decoder = {v: k for k, v in self.byte_encoder.items()}
        self.cache = {}
        self.pat = re.compile(r"""'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+""")

    def bpe(self, token):
        if token in self.cache:
            return self.cache[token]
        word = tuple(token)
        pairs = get_pairs(word)
        if not pairs:
            return token
        while True:
            bigram = min(pairs, key=lambda p: self.bpe_ranks.get(p, float("inf")))
            if bigram not in self.bpe_ranks:
                break
            first, second = bigram
            new_word, i = [], 0
            while i < len(word):
                try:
                    j = word.index(first, i)
                except ValueError:
                    new_word.extend(word[i:])
                    break
                new_word.extend(word[i:j])
                i = j
                if word[i] == first and i < len(word) - 1 and word[i + 1] == second:
                    new_word.append(first + second)
                    i += 2
                else:
                    new_word.append(word[i])
                    i += 1
            word = tuple(new_word)
            if len(word) == 1:
                break
            pairs = get_pairs(word)
        out = " ".join(word)
        self.cache[token] = out
        return out

    def encode(self, text):
        ids = []
        for tok in re.findall(self.pat, text):
            tok = "".join(self.byte_encoder[b] for b in tok.encode("utf-8"))
            ids.extend(self.encoder[t] for t in self.bpe(tok).split(" "))
        return ids

    def token_bytes(self, i):
        return bytes(self.byte_decoder[c] for c in self.decoder[i])

    def decode(self, ids):
        return b"".join(self.token_bytes(i) for i in ids).decode("utf-8", errors="replace")
