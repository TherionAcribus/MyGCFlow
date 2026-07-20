import unittest

from settings_manager import (
    MAX_OVERLAY_TITLE_LENGTH,
    coerce_profile,
    sanitize_overlay_css,
)


class OverlayProfileSanitizationTests(unittest.TestCase):
    def test_css_keeps_local_advanced_styles_and_removes_external_or_controller_rules(self):
        css = sanitize_overlay_css(
            "display: block; color: #fff; letter-spacing: 2px; "
            "background: linear-gradient(90deg, #000 0%, #fff 100%); "
            "background-image: url(https://example.invalid/tracker.png);"
        )

        self.assertNotIn("display", css.lower())
        self.assertNotIn("url(", css.lower())
        self.assertIn("letter-spacing: 2px", css)
        self.assertIn("linear-gradient", css)

    def test_imported_profile_limits_title_and_sanitizes_both_overlay_styles(self):
        profile = coerce_profile({
            "infos": {
                "title": {"display": True, "text": "x" * (MAX_OVERLAY_TITLE_LENGTH + 20)},
                "title_css": "display:none; color:red;",
                "infos_css": "background-image:url(https://example.invalid/x); opacity:.5;",
            }
        })

        self.assertEqual(len(profile.infos.title.text), MAX_OVERLAY_TITLE_LENGTH)
        self.assertNotIn("display", profile.infos.title_css.lower())
        self.assertIn("color: red", profile.infos.title_css)
        self.assertNotIn("url(", profile.infos.infos_css.lower())
        self.assertIn("opacity: .5", profile.infos.infos_css)


if __name__ == "__main__":
    unittest.main()
