"""The PyTorch finance workshop's slide short link and guide page."""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STARTER = "https://colab.research.google.com/github/omarcevi/pytorch-finance-workshop/blob/main/notebooks/workshop_starter.ipynb"


class PytorchWorkshopLinks(unittest.TestCase):
    def test_slide_short_link_redirects_to_the_starter_notebook(self):
        """omarcevi.dev/w/pytorch-finans (Slide 1) opens the starter notebook in Colab."""
        page = (ROOT / "w" / "pytorch-finans" / "index.html").read_text(encoding="utf-8")
        self.assertIn(f'<meta http-equiv="refresh" content="0; url={STARTER}">', page)
        self.assertIn(f'href="{STARTER}"', page)  # a visible link if the redirect doesn't run

    def test_guide_hero_has_no_solution_button(self):
        page = (ROOT / "workshops" / "pytorch-finance-workshop" / "index.html").read_text(encoding="utf-8")
        actions = re.search(r'<div class="actions">(.*?)</div>', page, re.S).group(1)
        self.assertIn("Starter notebook (Colab)", actions)
        self.assertNotIn("workshop_solution.ipynb", actions)


if __name__ == "__main__":
    unittest.main()
