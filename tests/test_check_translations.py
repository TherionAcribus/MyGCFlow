import contextlib
import io
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import check_missing_translations as checker

POT = '''#, fuzzy
msgid ""
msgstr ""
"Project-Id-Version: test\\n"

msgid "Mode de thème inconnu"
msgstr ""

msgid "Fermer"
msgstr ""
'''

PO_DOUTEUX = '''#, fuzzy
msgid ""
msgstr ""
"Project-Id-Version: test\\n"

#, fuzzy
msgid "Mode de thème inconnu"
msgstr "Unknown Adventure"

msgid "Fermer"
msgstr "Close"
'''


class FuzzyDetectionTests(unittest.TestCase):
    """Une entrée « #, fuzzy » est ignorée par pybabel compile : elle doit
    compter comme non traduite (7 cas par catalogue passaient inaperçus
    jusqu'au 2026-11-07)."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__('shutil').rmtree(self.tmp, True))
        (self.tmp / 'messages.pot').write_text(POT, encoding='utf-8')
        self.po = self.tmp / 'translations' / 'en' / 'LC_MESSAGES' / 'messages.po'
        self.po.parent.mkdir(parents=True)
        for name, value in (('POT_FILE', self.tmp / 'messages.pot'),
                            ('TRANSLATIONS_DIR', self.tmp / 'translations'),
                            ('SUPPORTED_LOCALES', ['en'])):
            patcher = mock.patch.object(checker, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def run_checker(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = checker.main()
        return code, out.getvalue()

    def test_fuzzy_entry_fails_the_check(self):
        self.po.write_text(PO_DOUTEUX, encoding='utf-8')
        code, out = self.run_checker()
        self.assertEqual(code, 1)
        self.assertIn('Douteux', out)
        self.assertIn('Mode de thème inconnu', out)
        # L'en-tête, souvent marqué fuzzy, n'est jamais une traduction.
        self.assertNotIn('Project-Id-Version', out)

    def test_clean_catalog_passes(self):
        self.po.write_text(PO_DOUTEUX.replace('#, fuzzy\nmsgid "Mode', 'msgid "Mode'), encoding='utf-8')
        code, out = self.run_checker()
        self.assertEqual(code, 0, out)


if __name__ == '__main__':
    unittest.main()
