"""Tab 05's trace: scripts/azure_trace.py's transform, and the JSON it wrote into assets/sim."""
import json
import math
import statistics
import sys
import unittest

from pagecheck import ROOT

sys.path.insert(0, str(ROOT / "scripts"))
import azure_trace  # noqa: E402

TRACE = ROOT / "assets" / "sim" / "azure-conv.json"

# Ten requests one second apart; row 8's prompt plus max_tokens (7200 + 1024) won't fit an 8192 context
ROWS = [(float(t), 100 * (t + 1), 10 * (t + 1)) for t in range(10)]
ROWS[8] = (8.0, 7200, 90)


class Transform(unittest.TestCase):
    def test_transform_keeps_every_4th_and_drops_what_wont_fit(self):
        d = azure_trace.transform(ROWS)
        self.assertEqual((d["requests"], d["sampled"], d["kept"]), (10, 3, 2))
        self.assertEqual(d["gapMs"], [0, 4000])
        self.assertEqual((d["prompt"], d["output"]), ([100, 500], [10, 50]))
        self.assertEqual(d["durationMs"], 9000)
        self.assertEqual(d["rate"], round(2 / (9000 / 12 / 1000), 2))
        self.assertEqual((d["every"], d["speed"], d["contextLimit"], d["maxTokens"]), (4, 12, 8192, 1024))

    def test_fit_matches_the_mean(self):
        f = azure_trace.fit([100, 200, 900])
        self.assertEqual((f["median"], f["min"], f["max"]), (200, 100, 900))
        self.assertEqual(f["sigma"], round(math.sqrt(2 * math.log(400 / 200)), 3))
        # a lognormal with this median and sigma has the data's mean
        self.assertAlmostEqual(f["median"] * math.exp(f["sigma"] ** 2 / 2), 400, delta=1)

    def test_peak_ratio_is_the_busiest_5_minutes_over_the_average(self):
        # 20 requests in the first 5 minutes, then 10 spread over the next 25
        rows = [(i * 15.0, 100, 10) for i in range(20)] + [(300 + i * 150.0, 100, 10) for i in range(10)]
        d = azure_trace.transform(rows, every=1)
        avg = 30 / (d["durationMs"] / 300000)
        self.assertEqual(d["peakRatio"], round(20 / avg, 2))


class CommittedTrace(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.raw = TRACE.read_bytes()
        cls.d = json.loads(cls.raw)

    def test_small_enough_to_ship(self):
        self.assertLess(len(self.raw), 100_000)

    def test_sampling_and_limits(self):
        d = self.d
        self.assertEqual((d["every"], d["speed"], d["maxTokens"], d["contextLimit"]), (4, 12, 1024, 8192))
        self.assertEqual(d["sampled"], math.ceil(d["requests"] / 4))
        self.assertLessEqual(d["kept"], d["sampled"])
        self.assertEqual(len(d["gapMs"]), d["kept"])
        self.assertEqual(len(d["prompt"]), d["kept"])
        self.assertEqual(len(d["output"]), d["kept"])
        self.assertLessEqual(sum(d["gapMs"]), d["durationMs"])
        self.assertTrue(all(g >= 0 for g in d["gapMs"]))
        self.assertTrue(all(p + d["maxTokens"] <= d["contextLimit"] for p in d["prompt"]))

    def test_fit_and_rate_match_the_arrays(self):
        d = self.d
        for key in ("prompt", "output"):
            values, f = d[key], d["fit"][key]
            median = int(round(statistics.median(values)))
            self.assertEqual((f["median"], f["min"], f["max"]), (median, min(values), max(values)))
            self.assertAlmostEqual(f["sigma"], math.sqrt(2 * math.log(statistics.mean(values) / median)), delta=0.001)
        self.assertEqual(d["rate"], round(d["kept"] / (d["durationMs"] / d["speed"] / 1000), 2))

    def test_credits(self):
        d = self.d
        self.assertEqual(d["license"], "CC-BY 4.0")
        self.assertIn("github.com/Azure/AzurePublicDataset", d["url"])
        self.assertIn("Splitwise", d["citation"])

    def test_not_in_ci(self):
        for wf in (ROOT / ".github" / "workflows").glob("*.yml"):
            self.assertNotIn("azure_trace", wf.read_text(), wf.name)


if __name__ == "__main__":
    unittest.main()
