#!/usr/bin/env python3
"""
The checkers are the safety net, so a broken one is the worst failure this project can have: it
reports success over the thing it was built to catch, and everyone stops looking.

That is not hypothetical. Two of these shipped broken on the day they were written. `sitecheck`
stripped fenced blocks from the store listings — where the fence *is* the copy that gets published —
and so passed on prose it had never read. Keeping the fences was worse: the inline-code pattern then
paired one fence's closing backticks with the next one's opening ticks and deleted everything
between two unrelated sections, emptying the file and reporting zero findings.

Every test below plants a defect that actually reached the user and asserts it is caught.

    python3 -m unittest discover -s tests -p 'tools_test.py'
"""
import pathlib
import re
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))

import sitecheck            # noqa: E402
import htmlcheck            # noqa: E402
import namecheck            # noqa: E402


class BareNames(unittest.TestCase):
    def test_bare_word_is_reported(self):
        self.assertTrue(sitecheck.bare_platform('<p>It never writes to Analytics.</p>'))

    def test_the_platform_named_in_full_is_fine(self):
        self.assertFalse(sitecheck.bare_platform('<p>It never writes to Zoho Analytics.</p>'))

    def test_our_short_form_is_fine(self):
        # The rule changed once: "Zoost Analytics" used to be forbidden in prose and is now a
        # declared short form. A checker encoding a superseded rule is a checker that cries wolf.
        self.assertFalse(sitecheck.bare_platform('<p>Zoost Analytics collects nothing.</p>'))

    def test_our_full_name_is_fine(self):
        self.assertFalse(sitecheck.bare_platform('<p>Zoost — workbench for Zoho CRM does this.</p>'))

    def test_code_and_paths_are_exempt(self):
        # `analytics/` is a folder, not a sentence.
        self.assertFalse(sitecheck.bare_platform('<code>analytics/CRM</code>'))


class UndeclaredForm(unittest.TestCase):
    def test_the_invented_fourth_form_is_reported(self):
        # "Zoost for Zoho CRM" was invented to make a nav button fit and then spread across the
        # whole site, displacing the real name and dropping the word "workbench" with it.
        self.assertIn('Zoost for Zoho CRM',
                      sitecheck.undeclared_form('<p>We call it Zoost for Zoho CRM.</p>'))

    def test_the_manifest_name_and_short_name_pass(self):
        html = '<h3>Zoost — workbench for Zoho Analytics</h3><b>Zoost CRM</b>'
        self.assertEqual(sitecheck.undeclared_form(html), [])

    def test_a_wrong_name_hidden_in_an_aria_label_is_reported(self):
        # Exactly where a name hides once the visible label has been reduced to an icon. The first
        # version of this check stripped tags before searching and could not see it.
        html = '<a aria-label="Zoost for Zoho CRM"><img alt=""></a>'
        self.assertTrue(sitecheck.undeclared_form(html))

    def test_the_platform_in_a_sentence_is_not_a_product_name(self):
        # A looser pattern reported "Zoost reads from the Zoho CRM instance", where "Zoho CRM" is
        # the platform and correct.
        self.assertEqual(
            sitecheck.undeclared_form('<p>Zoost reads from the Zoho CRM instance you are signed in to.</p>'), [])


class LabelsThatAttribute(unittest.TestCase):
    def test_a_bare_platform_name_as_a_whole_label_is_reported(self):
        # The footer badge said "Zoho CRM · Web Store 1.0.0", which is a claim about Zoho's product.
        self.assertTrue(sitecheck.ours_named_as_theirs('<a href="/crm.html">Zoho CRM</a>'))

    def test_the_platform_inside_a_sentence_is_left_alone(self):
        self.assertFalse(sitecheck.ours_named_as_theirs('<p>works with Zoho CRM today</p>'))


class StoreCopyIsProse(unittest.TestCase):
    """The store listings keep their fenced blocks, because the fence is the published copy."""

    def _check(self, name, body):
        import tempfile
        d = Path(tempfile.mkdtemp())
        f = d / name
        f.write_text(body, encoding='utf-8')
        found = []
        sitecheck.check_prose(f, found)
        return found

    def test_a_defect_inside_a_fence_is_seen_in_a_store_listing(self):
        body = '## 3. Description\n\n```\nZoost turns your CRM org into files.\n```\n'
        self.assertTrue(self._check('store-listing.md', body))

    def test_two_fences_do_not_swallow_the_text_between_them(self):
        # The bug: the inline-code pattern paired one fence's closing ticks with the next one's
        # opening ticks. Everything between two sections vanished and the file checked clean.
        body = ('```\nfirst block\n```\n\n'
                'Zoost turns your Analytics workspace into files.\n\n'
                '```\nsecond block\n```\n')
        self.assertTrue(self._check('store-listing.md', body),
                        'prose between two fenced blocks must still be read')

    def test_a_shell_command_in_the_readme_is_not_prose(self):
        self.assertEqual(self._check('README.md', '```bash\ncd apps/crm && ./build.sh crm\n```\n'), [])


class NameCheck(unittest.TestCase):
    def test_a_release_title_built_from_the_directory_name_is_reported(self):
        # GitHub published "Zoost for crm 1.9.0" because the workflow interpolated a directory name.
        wf = ROOT / '.github/workflows/release.yml'
        self.assertTrue(wf.exists())
        findings = []
        namecheck.check_release_workflow(findings)
        self.assertEqual(findings, [], 'the workflow in the repository must be correct')

    def test_every_shipped_file_passes_today(self):
        findings = []
        for app in namecheck.APPS:
            namecheck.check_app(app, findings)
            namecheck.check_bare_names(app, findings)
        self.assertEqual(findings, [])


class BareNamesInTheApps(unittest.TestCase):
    """The rule was enforced on the site and on nothing else, and the apps had drifted 27 times.

    Each case below is one of the three surfaces those defects actually lived on. The masking is the
    part that can go quietly wrong: strip the legitimate forms carelessly and "Zoho Analytics" starts
    reporting its own second word, which is the failure that makes a checker unreadable.
    """

    def bare(self, text):
        return list(namecheck.BARE.finditer(namecheck._mask_legit(text)))

    def test_a_bare_platform_name_in_prose_is_reported(self):
        self.assertTrue(self.bare('No answer from the Analytics page.'))
        self.assertTrue(self.bare('it never writes anything to CRM, ever'))

    def test_the_platform_named_in_full_is_silent(self):
        self.assertFalse(self.bare('No answer from the Zoho Analytics page.'))
        self.assertFalse(self.bare('it never writes anything to Zoho CRM, ever'))

    def test_our_own_names_are_silent(self):
        self.assertFalse(self.bare('Zoost CRM mirrors what you built'))
        self.assertFalse(self.bare('Zoost Analytics mirrors what you built'))
        self.assertFalse(self.bare('Zoost — workbench for Zoho Analytics'))

    def test_paths_and_identifiers_are_exempt(self):
        # `analytics/` is a folder and `CRM_HOSTS` is an identifier; neither is a sentence.
        self.assertFalse(self.bare('apps/analytics/sidepanel.js was written first'))
        self.assertFalse(self.bare('the value comes from CRM_HOSTS at the top'))

    def test_a_defect_in_an_html_attribute_is_reported(self):
        # This one shipped: a + Workspace tooltip reading "for the Analytics workspace".
        findings = []
        src = '<button title="Create a workspace for the Analytics workspace in the tab">Go</button>'
        with tempfile.TemporaryDirectory() as d:
            app = pathlib.Path(d) / 'apps' / 'analytics'
            app.mkdir(parents=True)
            (app / 'sidepanel.html').write_text(src, encoding='utf-8')
            old, namecheck.ROOT = namecheck.ROOT, pathlib.Path(d)
            try:
                namecheck.check_bare_names('analytics', findings)
            finally:
                namecheck.ROOT = old
        self.assertEqual(len(findings), 1, findings)
        self.assertIn('bare "Analytics"', findings[0])

    def test_a_short_label_is_not_a_sentence(self):
        # "Analytics tab" as a whole chip label has nowhere to put the platform; the check skips
        # anything under 12 characters rather than demanding prose of a badge.
        findings = []
        with tempfile.TemporaryDirectory() as d:
            app = pathlib.Path(d) / 'apps' / 'analytics'
            app.mkdir(parents=True)
            (app / 'x.js').write_text("const a = 'Analytics';", encoding='utf-8')
            old, namecheck.ROOT = namecheck.ROOT, pathlib.Path(d)
            try:
                namecheck.check_bare_names('analytics', findings)
            finally:
                namecheck.ROOT = old
        self.assertEqual(findings, [])


class HiddenActuallyHides(unittest.TestCase):
    """`hidden` is a UA rule and loses to any author `display`, silently.

    It shipped twice in one change and was found by the user opening Settings, not by a check. The
    check asks whether a page carries `[hidden]{display:none}` at all, rather than which element got
    it wrong — a per-element version would go quiet the moment a class grew a `display` later, which
    is precisely how this happened.
    """

    def page(self, body, css):
        d = tempfile.mkdtemp()
        p = pathlib.Path(d) / 'x.html'
        p.write_text(f'<style>\n{css}\n</style>\n{body}', encoding='utf-8')
        return p

    def test_a_page_using_hidden_without_the_rule_is_reported(self):
        p = self.page('<div id="r" class="row" hidden>x</div>', '.row{display:flex}')
        self.assertEqual(len(htmlcheck.display_override(p)), 1)

    def test_the_rule_silences_it(self):
        p = self.page('<div id="r" class="row" hidden>x</div>',
                      '[hidden]{display:none!important}\n.row{display:flex}')
        self.assertEqual(htmlcheck.display_override(p), [])

    def test_a_page_that_never_uses_hidden_is_not_asked_for_the_rule(self):
        p = self.page('<div class="row">x</div>', '.row{display:flex}')
        self.assertEqual(htmlcheck.display_override(p), [])

    def test_every_shipped_page_carries_it_today(self):
        findings = []
        for page in sorted((ROOT / 'apps').rglob('*.html')):
            findings += htmlcheck.display_override(page)
        self.assertEqual(findings, [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
