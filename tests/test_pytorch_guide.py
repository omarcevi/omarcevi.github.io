"""The PyTorch finance workshop's guide page."""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class PytorchWorkshopGuide(unittest.TestCase):
    def test_guide_hero_has_no_solution_button(self):
        page = (ROOT / "workshops" / "pytorch-finance-workshop" / "index.html").read_text(encoding="utf-8")
        actions = re.search(r'<div class="actions">(.*?)</div>', page, re.S).group(1)
        self.assertIn("Starter notebook (Colab)", actions)
        self.assertNotIn("workshop_solution.ipynb", actions)


if __name__ == "__main__":
    unittest.main()
