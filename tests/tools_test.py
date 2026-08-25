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
import contextlib
import io
import json
import os
import pathlib
import re
import shutil
import html
import struct
import subprocess
import sys
import ast
import tempfile
import types
import unittest
from unittest import mock
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))

import sitecheck
import whatsnew            # noqa: E402
import htmlcheck            # noqa: E402
import featurecheck         # noqa: E402
import namecheck            # noqa: E402
import sitemap              # noqa: E402
import twincheck            # noqa: E402


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
        self.assertFalse(sitecheck.bare_platform('<p>Zoost - workbench for Zoho CRM does this.</p>'))

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
        html = '<h3>Zoost - workbench for Zoho Analytics</h3><b>Zoost CRM</b>'
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
        self.assertFalse(self.bare('Zoost - workbench for Zoho Analytics'))

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

    def test_a_linked_stylesheet_counts(self):
        # The third occurrence was on the site, where almost all the CSS is in a linked sheet:
        # `.btn{display:inline-block}` beat `hidden`, so the Analytics page showed the install button
        # and its "in review" alternative at once, live. Reading only inline <style> saw none of it.
        d = pathlib.Path(tempfile.mkdtemp())
        (d / 'x.css').write_text('[hidden]{display:none!important}\n.btn{display:inline-block}', encoding='utf-8')
        p = d / 'x.html'
        p.write_text('<link rel="stylesheet" href="x.css">\n<a class="btn" hidden>x</a>', encoding='utf-8')
        self.assertEqual(htmlcheck.display_override(p), [])

    def test_a_linked_stylesheet_without_the_rule_is_still_reported(self):
        d = pathlib.Path(tempfile.mkdtemp())
        (d / 'x.css').write_text('.btn{display:inline-block}', encoding='utf-8')
        p = d / 'x.html'
        p.write_text('<link rel="stylesheet" href="x.css">\n<a class="btn" hidden>x</a>', encoding='utf-8')
        self.assertEqual(len(htmlcheck.display_override(p)), 1)

    def test_every_site_page_carries_it_today(self):
        bad = [f for page in sorted((ROOT / 'site').rglob('*.html'))
               for f in htmlcheck.display_override(page)]
        self.assertEqual(bad, [], 'a site page can hide nothing')

    def test_a_release_title_in_the_banned_fourth_form_is_reported(self):
        # "Zoost for Zoho CRM 1.11.0" was published twice. The first fix to this line checked only
        # whether the title used the *directory* name — the last bug, not the rule — so the form the
        # project explicitly banned went out on the most public surface there is.
        with tempfile.TemporaryDirectory() as d:
            wf = pathlib.Path(d) / '.github' / 'workflows'
            wf.mkdir(parents=True)
            (wf / 'release.yml').write_text('        with:\n          name: Zoost for ${{ x }} ${{ y }}\n',
                                            encoding='utf-8')
            old, namecheck.ROOT = namecheck.ROOT, pathlib.Path(d)
            try:
                findings = []
                namecheck.check_release_workflow(findings)
            finally:
                namecheck.ROOT = old
        self.assertEqual(len(findings), 1, findings)
        self.assertIn('declared name forms', findings[0])

    def test_the_workflow_in_the_repository_is_correct(self):
        findings = []
        namecheck.check_release_workflow(findings)
        self.assertEqual(findings, [])

    def test_every_shipped_page_carries_it_today(self):
        findings = []
        for page in sorted((ROOT / 'apps').rglob('*.html')):
            findings += htmlcheck.display_override(page)
        self.assertEqual(findings, [])


class StoreFieldLimits(unittest.TestCase):
    """A store field that does not fit is a submission that stops at the form.

    The CRM's storage justification had been over its 1000-character ceiling for some time and nothing
    was counting. It was found by counting while editing it, which is luck. The heading names the
    ceiling, so the criterion is derived: a section added tomorrow is measured without anyone
    remembering, and changing a limit means editing the heading and nothing else.
    """

    def listing(self, body):
        d = pathlib.Path(tempfile.mkdtemp())
        (d / 'store' / 'x').mkdir(parents=True)
        (d / 'store' / 'x' / 'store-listing.md').write_text(body, encoding='utf-8')
        return d

    def run_on(self, body):
        d = self.listing(body)
        old, sitecheck.ROOT = sitecheck.ROOT, d
        try:
            findings = []
            sitecheck.store_field_limits(findings)
            return findings
        finally:
            sitecheck.ROOT = old

    def test_a_field_over_its_stated_ceiling_is_reported(self):
        f = self.run_on('## 6. storage justification (max 10)\n\n```\n' + 'x' * 25 + '\n```\n')
        self.assertEqual(len(f), 1, f)
        self.assertIn('15 over the 10', f[0])

    def test_a_field_that_fits_is_silent(self):
        self.assertEqual(self.run_on('## 6. storage justification (max 100)\n\n```\nshort\n```\n'), [])

    def test_a_section_with_no_stated_ceiling_is_not_invented_one(self):
        self.assertEqual(self.run_on('## 3. Detailed description\n\n```\n' + 'x' * 5000 + '\n```\n'), [])

    def test_both_listings_fit_today(self):
        findings = []
        sitecheck.store_field_limits(findings)
        self.assertEqual(findings, [])


class TxtNeedsTheWorker(unittest.TestCase):
    """A .txt cannot declare its own encoding; only the header can, and only the Worker sets it.

    Static assets are served first, so a .txt not listed in run_worker_first never reaches that code.
    The em-dash bug was reported, declared fixed, and stayed live for exactly this reason — the fix
    was verified by reading the bytes, which had never been wrong.
    """

    def cfg(self, routes, files):
        d = pathlib.Path(tempfile.mkdtemp())
        (d / 'site').mkdir()
        (d / 'site' / 'wrangler.jsonc').write_text(
            '{ "assets": { "run_worker_first": [%s] } }' % ', '.join(f'"{r}"' for r in routes),
            encoding='utf-8')
        for f in files:
            (d / 'site' / f).write_text('x', encoding='utf-8')
        return d

    def run_on(self, routes, files):
        d = self.cfg(routes, files)
        oldr, olds = sitecheck.ROOT, sitecheck.SITE
        sitecheck.ROOT, sitecheck.SITE = d, d / 'site'
        try:
            findings = []
            sitecheck.txt_served_by_worker(findings)
            return findings
        finally:
            sitecheck.ROOT, sitecheck.SITE = oldr, olds

    def test_an_unrouted_txt_is_reported(self):
        f = self.run_on(['/robots.txt'], ['llms.txt', 'robots.txt'])
        self.assertEqual(len(f), 1, f)
        self.assertIn('llms.txt', f[0])

    def test_all_routed_is_silent(self):
        self.assertEqual(self.run_on(['/llms.txt', '/robots.txt'], ['llms.txt', 'robots.txt']), [])

    def test_a_missing_config_is_reported_rather_than_assumed_fine(self):
        d = pathlib.Path(tempfile.mkdtemp())
        (d / 'site').mkdir()
        oldr, olds = sitecheck.ROOT, sitecheck.SITE
        sitecheck.ROOT, sitecheck.SITE = d, d / 'site'
        try:
            findings = []
            sitecheck.txt_served_by_worker(findings)
        finally:
            sitecheck.ROOT, sitecheck.SITE = oldr, olds
        self.assertEqual(len(findings), 1, findings)

    def test_the_site_is_routed_today(self):
        findings = []
        sitecheck.txt_served_by_worker(findings)
        self.assertEqual(findings, [])


class HostsAreDeclared(unittest.TestCase):
    """Every host a manifest may reach must be named in the privacy policy.

    `one.zoho.*` was in the Zoho CRM manifest and missing from §5's opening paragraph for three
    readings — the page contained the fact further down, and the sentence a reader starts from did
    not. Deriving the list from the manifests also found three nobody had reported: the Canadian
    `zohocloud.ca` data centres were reachable and named nowhere.
    """

    def run_on(self, hosts, policy_text):
        # Wrapped in a section 5 and written in both languages, because that is where the check now
        # looks: the whole file was a poor place to search for a permission disclosure - `zoost.it`
        # is in the canonical link, the og:url and a mailto on every page, so a manifest reaching
        # `zoost.it/*` satisfied the old check while §5 named it nowhere and closed with «no access
        # to any site other than those listed above».
        d = pathlib.Path(tempfile.mkdtemp())
        (d / 'site' / 'it').mkdir(parents=True); (d / 'apps' / 'crm').mkdir(parents=True)
        page = f'<h2>4. Elsewhere</h2><p>zoost.it one.zoho.com</p><h2>5. Permissions</h2><p>{policy_text}</p><h2>6. End</h2>'
        (d / 'site' / 'privacy.html').write_text(page, encoding='utf-8')
        (d / 'site' / 'it' / 'privacy.html').write_text(page, encoding='utf-8')
        (d / 'apps' / 'crm' / 'manifest.json').write_text(
            json.dumps({'host_permissions': hosts}), encoding='utf-8')
        oldr, olds = sitecheck.ROOT, sitecheck.SITE
        sitecheck.ROOT, sitecheck.SITE = d, d / 'site'
        try:
            findings = []
            sitecheck.hosts_declared(findings)
            return findings
        finally:
            sitecheck.ROOT, sitecheck.SITE = oldr, olds

    def test_an_undeclared_host_family_is_reported(self):
        # One per language: the disclosure exists in two and the check reads both.
        f = self.run_on(['https://crm.zoho.com/*', 'https://one.zoho.com/*'], 'we reach crm.zoho.*')
        self.assertEqual(len(f), 2, f)
        self.assertIn('one.zoho', f[0])

    def test_a_host_named_outside_section_five_does_not_count(self):
        # The defect this widening was written for. The fixture's §4 mentions the host; §5 does not.
        f = self.run_on(['https://zoost.it/*'], 'we reach crm.zoho.*')
        self.assertEqual(len(f), 2, f)
        self.assertIn('zoost.it', f[0])

    def test_a_different_tld_is_a_different_family(self):
        # crm.zohocloud.ca is not covered by "crm.zoho.*", which is exactly how it went unnoticed.
        f = self.run_on(['https://crm.zohocloud.ca/*'], 'we reach crm.zoho.*')
        self.assertEqual(len(f), 2, f)

    def test_all_declared_is_silent(self):
        self.assertEqual(self.run_on(['https://crm.zoho.com/*'], 'we reach crm.zoho.* only'), [])

    def test_the_repository_declares_everything_today(self):
        findings = []
        sitecheck.hosts_declared(findings)
        self.assertEqual(findings, [])


class ContentSecurityPolicy(unittest.TestCase):
    """The one security decision the project had left implicit.

    MV3's default already blocks inline script and remote code, and the extensions relied on it
    without saying so — every other security property here is written down. Declaring it changes no
    behaviour and makes the decision reviewable, and it can only be *tightened*: Chrome rejects a
    policy that relaxes script-src or object-src, so a future edit that tries cannot ship.
    """

    def policies(self):
        out = {}
        for mf in sorted((ROOT / 'apps').glob('*/manifest.json')):
            out[mf.parent.name] = json.loads(mf.read_text(encoding='utf-8')).get('content_security_policy')
        return out

    def test_both_apps_declare_one(self):
        for app, csp in self.policies().items():
            self.assertIsNotNone(csp, f'{app}: no content_security_policy')
            self.assertIn('extension_pages', csp, app)

    def test_the_two_are_identical(self):
        vals = {app: csp['extension_pages'] for app, csp in self.policies().items()}
        self.assertEqual(len(set(vals.values())), 1, vals)

    def test_it_never_relaxes_what_mv3_enforces(self):
        # 'unsafe-inline', 'unsafe-eval', a remote origin or a data: source would each be a relaxation
        # Chrome refuses — and the point of writing the policy down is that the refusal is visible here
        # first, at the moment someone tries.
        for app, csp in self.policies().items():
            p = csp['extension_pages']
            for bad in ("'unsafe-inline'", "'unsafe-eval'", 'http://', 'https://', 'data:', "'wasm-unsafe-eval'"):
                self.assertNotIn(bad, p, f'{app}: policy relaxes with {bad}')
            self.assertIn("script-src 'self'", p, app)
            self.assertIn("object-src 'self'", p, app)

    def test_nothing_shipped_needs_what_the_policy_forbids(self):
        # base-uri and form-action are tightenings, safe only because nothing uses them. If a <form>
        # or a <base> ever lands, this says so before a user meets a control that silently does not work.
        for page in sorted((ROOT / 'apps').glob('*/*.html')):
            src = page.read_text(encoding='utf-8')
            self.assertNotIn('<form', src, f'{page.name}: a form, with form-action none')
            self.assertNotIn('<base', src, f'{page.name}: a base element, with base-uri self')


class GuidesDepictMarks(unittest.TestCase):
    """A control drawn as a mark must be drawn in the guide, not spelled out.

    featurecheck reads aria-label, so the *name* was on the site and the check stayed green while the
    guide told a reader to press a button whose label the panel no longer shows. Reported by the user,
    which is the failure: the panel and the page changed in the same session and only one was looked at.
    """

    def test_both_guides_depict_every_mark_today(self):
        findings = []
        featurecheck.guides_depict_marks(findings)
        self.assertEqual(findings, [])

    def test_a_guide_that_only_spells_it_out_is_reported(self):
        page = (ROOT / 'site' / 'docs-analytics.html').read_text(encoding='utf-8')
        stripped = re.sub(r'<b class="ui"><svg class="mk".*?</svg> (Pull all)</b>', r'<b class="ui">\1</b>',
                          page, flags=re.S)
        self.assertNotEqual(stripped, page, 'the fixture no longer matches the guide')
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            (root / 'site').mkdir()
            (root / 'apps' / 'analytics').mkdir(parents=True)
            (root / 'apps' / 'crm').mkdir(parents=True)
            (root / 'site' / 'docs-analytics.html').write_text(stripped, encoding='utf-8')
            (root / 'site' / 'docs-crm.html').write_text(
                (ROOT / 'site' / 'docs-crm.html').read_text(encoding='utf-8'), encoding='utf-8')
            for app in ('analytics', 'crm'):
                (root / 'apps' / app / 'sidepanel.html').write_text(
                    (ROOT / 'apps' / app / 'sidepanel.html').read_text(encoding='utf-8'), encoding='utf-8')
            oldr, olds = featurecheck.ROOT, featurecheck.SITE
            featurecheck.ROOT, featurecheck.SITE = root, root / 'site'
            try:
                findings = []
                featurecheck.guides_depict_marks(findings)
            finally:
                featurecheck.ROOT, featurecheck.SITE = oldr, olds
        self.assertEqual(len(findings), 1, findings)
        self.assertIn('Pull all', findings[0])


class TranslationsInStep(unittest.TestCase):
    """A translated page records the commit of the English page it was made from.

    A second language is the thing this repository spends its effort not having: a surface that can
    quietly stop being true. Nobody has to remember to update the Italian — forgetting makes it
    *reported*, which is the only direction that fails safe.
    """

    def page(self, marker):
        d = pathlib.Path(tempfile.mkdtemp())
        (d / 'site' / 'it').mkdir(parents=True)
        (d / 'site' / 'it' / 'crm.html').write_text(marker + '\n<html></html>', encoding='utf-8')
        return d

    def run_on(self, marker):
        d = self.page(marker)
        oldr, olds = sitecheck.ROOT, sitecheck.SITE
        sitecheck.ROOT, sitecheck.SITE = d, d / 'site'
        try:
            findings = []
            sitecheck.translations_current(findings)
            return findings
        finally:
            sitecheck.ROOT, sitecheck.SITE = oldr, olds

    def test_a_page_with_no_marker_is_reported(self):
        f = self.run_on('<!-- nothing here -->')
        self.assertEqual(len(f), 1, f)
        self.assertIn('translated-from', f[0])

    def test_a_marker_naming_a_missing_file_is_reported(self):
        f = self.run_on('<!-- translated-from: site/does-not-exist.html sha256:abc1234def5678 -->')
        self.assertEqual(len(f), 1, f)
        self.assertIn('does not exist', f[0])

    def test_the_italian_page_is_in_step_today(self):
        findings = []
        sitecheck.translations_current(findings)
        self.assertEqual(findings, [], 'site/it is behind — retranslate what moved and update the marker')

    def test_a_stale_marker_is_reported(self):
        page = ROOT / 'site' / 'it' / 'crm.html'
        original = page.read_text(encoding='utf-8')
        stale = re.sub(r'(translated-from: \S+ sha256:)[0-9a-f]+', r'\g<1>0000000000000000', original, count=1)
        self.assertNotEqual(stale, original, 'the marker is gone')
        page.write_text(stale, encoding='utf-8')
        try:
            findings = []
            sitecheck.translations_current(findings)
        finally:
            page.write_text(original, encoding='utf-8')
        self.assertEqual(len(findings), 1, findings)
        self.assertIn('has changed since this was translated', findings[0])


class ClassesAreStyled(unittest.TestCase):
    """A class used but never defined renders as nothing, and nothing is hard to see.

    CLAUDE.md carried this as a one-liner that pooled site.css with **every** page's inline <style>
    and then asked each page separately — so a class defined in one page's block read as defined on
    all of them. It reported nothing for months while /how-to.html rendered its two product cards,
    and both guides their callouts, as unstyled paragraphs: `.card`, `.cards` and `.note` lived in
    the landing pages' inline styles and in no shared file.
    """

    def site(self, css, pages):
        d = pathlib.Path(tempfile.mkdtemp())
        (d / 'site' / 'it').mkdir(parents=True)
        (d / 'site' / 'site.css').write_text(css, encoding='utf-8')
        for name, body in pages.items():
            (d / 'site' / name).write_text(body, encoding='utf-8')
        return d

    def run_on(self, css, pages):
        d = self.site(css, pages)
        old = sitecheck.SITE
        sitecheck.SITE = d / 'site'
        try:
            findings = []
            sitecheck.classes_defined(findings)
            return findings
        finally:
            sitecheck.SITE = old

    def test_a_class_nothing_styles_is_reported(self):
        f = self.run_on('.wrap{}', {'a.html': '<div class="cards">x</div>'})
        self.assertEqual(len(f), 1, f)
        self.assertIn('cards', f[0])

    def test_the_shared_sheet_satisfies_it(self):
        self.assertEqual(self.run_on('main .cards{display:grid}', {'a.html': '<div class="cards">x</div>'}), [])

    def test_a_page_own_style_block_satisfies_it(self):
        f = self.run_on('.wrap{}', {'a.html': '<style>.cards{display:grid}</style><div class="cards">x</div>'})
        self.assertEqual(f, [])

    def test_one_page_style_block_does_not_cover_another(self):
        # The whole reason the one-liner was blind. `.cards` is styled on a.html only.
        f = self.run_on('.wrap{}', {'a.html': '<style>.cards{display:grid}</style><div class="cards">x</div>',
                                    'b.html': '<div class="cards">x</div>'})
        self.assertEqual(len(f), 1, f)
        self.assertIn('b.html', f[0])

    def test_a_longer_class_is_not_a_definition_of_a_shorter_one(self):
        # `f'.{c}' in css` — the substring test — counts `.cards` as styling `.card`.
        f = self.run_on('main .cards{display:grid}', {'a.html': '<div class="card">x</div>'})
        self.assertEqual(len(f), 1, f)

    def test_a_script_hook_is_not_asked_for_a_rule(self):
        self.assertEqual(self.run_on('.wrap{}', {'a.html': '<span class="cyear"></span>'}), [])

    def test_every_page_is_fully_styled_today(self):
        findings = []
        sitecheck.classes_defined(findings)
        self.assertEqual(findings, [], 'a class renders as nothing on a live page')


class TranslationsLinkToTranslations(unittest.TestCase):
    """A link from an Italian page to a page that has an Italian version must use it.

    Reported by the user: the Italian home's two «Come si usa →» links opened the English guides.
    Two more had been fixed and then thrown away by a `git checkout` used to undo a deliberate
    mutation while proving a different checker — it reverted the real work in the same file, and
    nothing noticed. Deliberate cross-language links declare themselves with hreflang="en".
    """

    def run_on(self, pages):
        d = pathlib.Path(tempfile.mkdtemp())
        (d / 'site' / 'it').mkdir(parents=True)
        for name, body in pages.items():
            (d / 'site' / name).write_text(body, encoding='utf-8')
        old = sitecheck.SITE
        sitecheck.SITE = d / 'site'
        try:
            findings = []
            sitecheck.translations_link_to_translations(findings)
            return findings
        finally:
            sitecheck.SITE = old

    def test_a_link_to_the_english_twin_is_reported(self):
        f = self.run_on({'a.html': 'x', 'it/a.html': 'x',
                         'it/b.html': '<a href="/a.html">Come si usa</a>'})
        self.assertEqual(len(f), 1, f)
        self.assertIn('it/a.html exists', f[0])

    def test_the_italian_target_is_silent(self):
        self.assertEqual(self.run_on({'a.html': 'x', 'it/a.html': 'x',
                                      'it/b.html': '<a href="/it/a.html">Come si usa</a>'}), [])

    def test_a_declared_english_link_is_silent(self):
        self.assertEqual(self.run_on({'a.html': 'x', 'it/a.html': 'x',
                                      'it/b.html': '<a href="/a.html" hreflang="en">versione inglese</a>'}), [])

    def test_a_page_with_no_translation_is_not_reported(self):
        self.assertEqual(self.run_on({'privacy.html': 'x',
                                      'it/b.html': '<a href="/privacy.html">Privacy</a>'}), [])

    def test_the_home_counts_as_index(self):
        f = self.run_on({'index.html': 'x', 'it/index.html': 'x', 'it/b.html': '<a href="/">home</a>'})
        self.assertEqual(len(f), 1, f)

    def test_the_site_is_correct_today(self):
        findings = []
        sitecheck.translations_link_to_translations(findings)
        self.assertEqual(findings, [], 'an Italian page links an English page that has a translation')


class SharedProseStaysShared(unittest.TestCase):
    """Prose identical on two English pages must stay identical on their two translations.

    The twin rule one layer down. crm.html and analytics.html say the same twenty things word for
    word; the Italian pages said eleven of them differently — «leggi ciò che viene spedito» against
    «leggi quello che viene distribuito». Nothing wrong in either, and that is the point: a reader
    moving between the two meets the same sentence twice in two voices.

    The first version counted shared blocks per pair. It is kept here as a cautionary case: the
    Italian pages happened to share more blocks than the English ones, and that spare swallowed a
    drift reintroduced on purpose. Positional pairing replaced it.
    """

    LONG_A = 'This is a claim both English pages make, word for word, and it is long enough to count.'
    LONG_B = 'A second shared claim, also stated identically on both pages, also comfortably long.'

    def site(self, pages):
        d = pathlib.Path(tempfile.mkdtemp())
        (d / 'site' / 'it').mkdir(parents=True)
        for name, body in pages.items():
            (d / 'site' / name).write_text(
                f'<header></header><section>{body}</section><footer></footer>', encoding='utf-8')
        old = sitecheck.SITE
        sitecheck.SITE = d / 'site'
        try:
            findings = []
            sitecheck.shared_prose_stays_shared(findings)
            return findings
        finally:
            sitecheck.SITE = old

    def test_the_same_wording_on_both_translations_is_silent(self):
        f = self.site({
            'a.html': f'<p>{self.LONG_A}</p><p>only on a</p>',
            'b.html': f'<p>only on b</p><p>{self.LONG_A}</p>',
            'it/a.html': '<p>Una affermazione condivisa, abbastanza lunga da contare davvero.</p><p>solo su a</p>',
            'it/b.html': '<p>solo su b</p><p>Una affermazione condivisa, abbastanza lunga da contare davvero.</p>',
        })
        self.assertEqual(f, [])

    def test_two_wordings_of_one_shared_claim_are_reported(self):
        f = self.site({
            'a.html': f'<p>{self.LONG_A}</p><p>only on a</p>',
            'b.html': f'<p>only on b</p><p>{self.LONG_A}</p>',
            'it/a.html': '<p>Una affermazione condivisa, abbastanza lunga da contare davvero.</p><p>solo su a</p>',
            'it/b.html': '<p>solo su b</p><p>Un asserto condiviso, sufficientemente lungo da contare.</p>',
        })
        self.assertEqual(len(f), 1, f)
        self.assertIn('word the same claim two ways', f[0])

    def test_a_single_drift_is_not_absorbed_by_a_spare_shared_block(self):
        # Exactly what defeated the counting version: the Italian pair shares a block the English
        # pair does not, so the count stayed level while a real drift went through.
        f = self.site({
            'a.html': f'<p>{self.LONG_A}</p><p>{self.LONG_B}</p><p>only on a, and quite long as well</p>',
            'b.html': f'<p>{self.LONG_A}</p><p>{self.LONG_B}</p><p>only on b, and quite long as well</p>',
            'it/a.html': '<p>Prima affermazione condivisa, abbastanza lunga da contare davvero.</p>'
                         '<p>Seconda affermazione condivisa, anche questa lunga abbastanza.</p>'
                         '<p>Un blocco che le due pagine italiane condividono e le inglesi no.</p>',
            'it/b.html': '<p>Prima affermazione condivisa, ma detta in tutt\'altro modo qui.</p>'
                         '<p>Seconda affermazione condivisa, anche questa lunga abbastanza.</p>'
                         '<p>Un blocco che le due pagine italiane condividono e le inglesi no.</p>',
        })
        self.assertEqual(len(f), 1, f)

    def test_an_undeclared_structural_addition_is_reported(self):
        f = self.site({
            'a.html': f'<p>{self.LONG_A}</p>',
            'it/a.html': f'<p>tradotto</p><p>e una nota in più</p>',
        })
        self.assertEqual(len(f), 1, f)
        self.assertIn('data-it-only', f[0])

    def test_a_declared_addition_is_skipped(self):
        f = self.site({
            'a.html': f'<p>{self.LONG_A}</p>',
            'it/a.html': f'<p>tradotto</p><p data-it-only>e una nota in più</p>',
        })
        self.assertEqual(f, [])

    def test_the_site_is_consistent_today(self):
        findings = []
        sitecheck.shared_prose_stays_shared(findings)
        self.assertEqual(findings, [], 'a shared claim is worded two ways in Italian')


class CanonicalPointsAtItself(unittest.TestCase):
    """A canonical naming another page tells a search engine the two are one, and the other wins.

    `site/analytics.html` and `site/index.html` both carried `crm.html`'s canonical, copied along
    with the head block — so the Analytics product page and the suite home were each asking to be
    dropped in favour of the CRM page. Every check here read the body; nothing read the head.
    """

    def run_on(self, pages):
        d = pathlib.Path(tempfile.mkdtemp())
        (d / 'site' / 'it').mkdir(parents=True)
        for name, body in pages.items():
            (d / 'site' / name).write_text(body, encoding='utf-8')
        old = sitecheck.SITE
        sitecheck.SITE = d / 'site'
        try:
            findings = []
            sitecheck.canonical_and_alternates(findings)
            return findings
        finally:
            sitecheck.SITE = old

    def test_a_canonical_naming_another_page_is_reported(self):
        f = self.run_on({'a.html': '<link rel="canonical" href="https://zoost.it/crm.html">'})
        self.assertEqual(len(f), 1, f)
        self.assertIn('different page', f[0])

    def test_its_own_url_is_silent(self):
        # `a.html` is served at `/a`, so that — not the file name — is what the page must declare.
        self.assertEqual(self.run_on({'a.html': '<link rel="canonical" href="https://zoost.it/a">'}), [])

    def test_the_file_name_is_not_the_url(self):
        # The defect this whole check missed for months: Cloudflare 307s `/a.html` to `/a`, so a
        # canonical naming the `.html` form points at a redirect and the URL that answers 200 calls
        # itself an alternative of it. Google indexes neither.
        f = self.run_on({'a.html': '<link rel="canonical" href="https://zoost.it/a.html">'})
        self.assertEqual(len(f), 1, f)
        self.assertIn('different page', f[0])

    def test_the_home_may_name_the_bare_origin(self):
        self.assertEqual(self.run_on({'index.html': '<link rel="canonical" href="https://zoost.it/">'}), [])

    def test_a_translated_home_names_its_directory(self):
        self.assertEqual(self.run_on({'it/index.html': '<link rel="canonical" href="https://zoost.it/it/">'}), [])

    def test_a_translated_pair_must_point_both_ways(self):
        # The Italian pages declared their original from the day they were written; the English ones
        # said nothing back. A one-way pair leaves the engine to pick which language a reader lands on.
        f = self.run_on({
            'a.html': '<link rel="canonical" href="https://zoost.it/a">',
            'it/a.html': '<link rel="canonical" href="https://zoost.it/it/a">'
                         '<link rel="alternate" hreflang="en" href="https://zoost.it/a">'
                         '<link rel="alternate" hreflang="it" href="https://zoost.it/it/a">',
        })
        self.assertEqual(len(f), 2, f)          # the English page is missing both directions
        self.assertTrue(all(x.startswith('a.html') for x in f), f)

    def test_a_page_with_no_translation_is_not_asked_for_alternates(self):
        self.assertEqual(self.run_on({'a.html': '<link rel="canonical" href="https://zoost.it/a">'}), [])

    def test_the_site_is_correct_today(self):
        findings = []
        sitecheck.canonical_and_alternates(findings)
        self.assertEqual(findings, [], 'a canonical or an hreflang pair is wrong')


class WhatsNew(unittest.TestCase):
    """Release notes derived from the commits that touched one app.

    Two products come out of one history, so «what changed in Zoho CRM» is not the last N commits.
    It was being written from memory, which is the wrong source for the one question a release note
    has to get right: whether anything is missing.
    """

    def test_versions_sort_numerically(self):
        # 1.10.0 sorts before 1.9.0 as text, and the ledger will reach 1.10 long before anyone looks.
        tags = ['crm-v1.9.0', 'crm-v1.10.0', 'crm-v1.2.0']
        self.assertEqual(max(tags, key=whatsnew.semver), 'crm-v1.10.0')

    def test_a_tag_that_is_not_a_version_sorts_last_rather_than_crashing(self):
        self.assertEqual(whatsnew.semver('v1.0.0'), (0, 0, 0))       # the legacy unprefixed tag
        self.assertEqual(whatsnew.semver('crm-vX'), (0, 0, 0))

    def test_the_record_separator_would_have_destroyed_every_row(self):
        # This is the bug, kept: \x1e is the obvious separator for `git log --format`, and Python's
        # splitlines() treats it as a line boundary — along with \x1c, \x1d, \x85,  ,  .
        # Every record broke in half and the tool answered "no commit has touched this app", which is
        # the worst answer a release-notes tool can give.
        raw = 'abc123\x1eA subject\ndef456\x1eAnother subject'
        self.assertEqual(len(raw.splitlines()), 4, 'splitlines() splits on \\x1e — that is the trap')
        self.assertEqual(len(raw.split('\n')), 2, 'splitting on \\n keeps the records whole')
        # what the tool uses now
        tabbed = 'abc123\tA subject\ndef456\tAnother subject'
        rows = [l.split('\t', 1) for l in tabbed.split('\n') if '\t' in l]
        self.assertEqual(rows, [['abc123', 'A subject'], ['def456', 'Another subject']])

    def test_it_reports_this_repository_today(self):
        if shallow_clone():
            self.skipTest('shallow clone - what changed since a tag is a question about history')
        # The range is the app's **first** tag rather than its newest, and that is the whole point of
        # this case. Asking since the newest tag went red the day a release was cut - no commit has
        # touched the app since, correctly - and a test that fails for a benign reason is one whose
        # red stops meaning anything. It exists to catch the \x1e bug, whose signature is finding
        # nothing where there is plainly something, so it has to ask a range that cannot be empty.
        for app in ('crm', 'analytics'):
            tags = subprocess.run(['git', '-C', str(ROOT), 'tag', '--list', f'{app}-v*'],
                                  capture_output=True, text=True).stdout.split()
            if not tags:
                continue                                  # nothing released for this app yet
            first = min(tags, key=lambda t: [int(x) for x in re.search(r'-v(\d+)\.(\d+)\.(\d+)$', t).groups()])
            out = subprocess.run([sys.executable, str(ROOT / 'tools/whatsnew.py'), app, '--since', first],
                                 capture_output=True, text=True)
            self.assertEqual(out.returncode, 0, out.stderr)
            self.assertIn('commit(s) touched', out.stdout,
                          f'{app}: the tool found nothing since {first}, '
                          f'which is what the \\x1e bug looked like')
            self.assertNotIn('no commit has touched', out.stdout)


class AQualifiedSelectorIsNotADefinition(unittest.TestCase):
    """`main td.k` styles that class on a `td`, and this check read it as styling `.k` everywhere.

    Four product pages defined `.k` in their own inline block; a fifth page then used it on a
    `<span>` with no rule at all, and the span rendered as ordinary text while sitecheck passed -
    because `td.k` in site.css matched the pattern. Measured in a browser, not read off the CSS:
    the span's computed style was identical to its paragraph's.
    """

    def test_an_element_qualified_rule_does_not_answer_for_another_element(self):
        css = 'main td.k{white-space:nowrap}'
        self.assertFalse(sitecheck.defines(css, 'k', {'span'}))
        self.assertTrue(sitecheck.defines(css, 'k', {'td'}), 'a td carrying it is styled')

    def test_a_compound_of_classes_still_defines_it(self):
        # The first fix reported every `.nprod.ncrm` in the nav. A checker that turns on its own
        # markup is one nobody reads, so "qualified" was the wrong test - "does it reach the elements
        # that carry it" is the right one.
        self.assertTrue(sitecheck.defines('a.nprod.ncrm{color:red}', 'ncrm', {'a'}))
        self.assertTrue(sitecheck.defines('#hero.wide{color:red}', 'wide', {'div'}))

    def test_a_plain_rule_defines_it_for_anything(self):
        self.assertTrue(sitecheck.defines('main .k{font-weight:600}', 'k', {'span', 'td'}))

    def test_the_trailing_boundary_still_holds(self):
        self.assertFalse(sitecheck.defines('.cards{display:grid}', 'card', {'div'}))

    def test_the_markup_says_which_elements_carry_it(self):
        html = '<p>x <span class="k out">a</span></p><table><td class="k">b</td></table>'
        self.assertEqual(sitecheck.carried_by(html, 'k'), {'span', 'td'})
        self.assertEqual(sitecheck.carried_by(html, 'out'), {'span'})

    def test_the_site_is_correct_today(self):
        findings = []
        sitecheck.classes_defined(findings)
        self.assertEqual(findings, [], 'a class is used with no rule that reaches it')


class ReleaseNotesAreARequirement(unittest.TestCase):
    """A release without notes is one nobody can read, and the Store has no field for them.

    `release.yml` already wrote a body — hash, commit, verification commands — so the Release looked
    finished, which is exactly why nobody noticed it never said what had changed. 69 commits reached
    one submission answering only "is this archive what it claims to be". The Chrome Web Store has no
    per-version note anywhere on its listing tab, so the Release is the only place these can be
    published: forgetting them is unrecoverable, not untidy, and the tagging step therefore refuses
    rather than warning.

    Run against a throwaway repository, because the gate sits before the build and the point is what
    the script *does*, not what its source contains.
    """

    def _repo(self, tmp, notes=None):
        root = pathlib.Path(tmp)
        (root / 'apps/crm').mkdir(parents=True)
        (root / 'apps/crm/manifest.json').write_text('{"version": "9.9.9"}', encoding='utf-8')
        (root / 'tools').mkdir()
        (root / 'tools/release.sh').write_bytes((ROOT / 'tools/release.sh').read_bytes())
        (root / 'tools/release.sh').chmod(0o755)
        if notes is not None:
            p = root / 'store/crm/whatsnew/9.9.9.md'
            p.parent.mkdir(parents=True)
            p.write_text(notes, encoding='utf-8')
        for a in (['init', '-q'], ['add', '-A'], ['-c', 'user.email=t@t', '-c', 'user.name=t',
                                                  'commit', '-qm', 'x']):
            subprocess.run(['git', '-C', str(root), *a], check=True, capture_output=True)
        return subprocess.run(['bash', str(root / 'tools/release.sh'), 'crm'],
                              capture_output=True, text=True)

    def test_it_refuses_to_tag_without_them(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = self._repo(tmp, None)
        self.assertNotEqual(out.returncode, 0, 'a release with no notes was allowed to tag')
        self.assertIn('store/crm/whatsnew/9.9.9.md', out.stdout,
                      'the refusal has to name the file to write')
        self.assertIn('whatsnew.py', out.stdout, 'and how to gather the raw material')

    def test_it_gets_past_them_once_they_exist(self):
        # The discriminating half: with the file present it must fail for some *other* reason (there
        # is no build.sh in the throwaway repo), never for the notes. A gate that refuses either way
        # is not a gate.
        with tempfile.TemporaryDirectory() as tmp:
            out = self._repo(tmp, 'Something changed.\n')
        self.assertNotIn('No release notes', out.stdout + out.stderr)

    def test_an_empty_file_does_not_count(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = self._repo(tmp, '')
        self.assertIn('No release notes', out.stdout,
                      'an empty notes file satisfied the check, which is the same as no notes')

    def test_two_pngs_of_one_picture_are_recognised_as_one(self):
        # `cmp` answers a question nobody asked: a PNG encoder chooses a row filter per row and a
        # deflate level, so one picture has many valid encodings. siteimg has compared *pixels* for
        # WebP since it started leaving unchanged files alone; the PNG half was missing, and it was
        # missing where it decides things - the Store's screenshots, and any comparison between two
        # ways of capturing the same page.
        #
        # Built here rather than shipped as fixtures: two encodings of the same 2x2 image, one with
        # every row unfiltered and one with the Up filter, which is exactly the case bytes disagree
        # on and pixels do not.
        import struct, zlib
        sys.path.insert(0, str(ROOT / 'tools'))
        import pngsame

        def png(rows_with_filters):
            ihdr = struct.pack('>IIBBBBB', 2, 2, 8, 2, 0, 0, 0)
            body = b''.join(bytes([f]) + row for f, row in rows_with_filters)
            def chunk(kind, data):
                c = kind + data
                return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c))
            return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr)
                    + chunk(b'IDAT', zlib.compress(body)) + chunk(b'IEND', b''))

        red, blue = bytes([255, 0, 0, 255, 0, 0]), bytes([0, 0, 255, 0, 0, 255])
        plain = png([(0, red), (0, blue)])
        # the same two rows, second one stored as a difference from the first
        up = png([(0, red), (2, bytes((b - a) & 0xFF for a, b in zip(red, blue)))])
        with tempfile.TemporaryDirectory() as tmp:
            a, b = pathlib.Path(tmp) / 'a.png', pathlib.Path(tmp) / 'b.png'
            a.write_bytes(plain); b.write_bytes(up)
            self.assertNotEqual(plain, up, 'the two encodings are the same bytes, so this proves nothing')
            same, why = pngsame.compare(a, b)
            self.assertTrue(same, f'two encodings of one picture were called different: {why}')
            # and it has to be able to say no, or it is not a comparison
            c = pathlib.Path(tmp) / 'c.png'
            c.write_bytes(png([(0, blue), (0, red)]))
            differ, why = pngsame.compare(a, c)
            self.assertFalse(differ, 'a different picture passed as the same one')
            self.assertIn('pixels differ', why)

    def test_the_long_renders_say_where_they_are(self):
        # A silent process and a hung one are the same thing from outside. siteimg rendered 27 images
        # for thirty-four minutes without a line, and the only way to tell it was alive was Chrome's
        # process table. Two halves are asserted because the second is the one that gets forgotten:
        # the line has to be printed *before* the work, and it has to be flushed - stdout is
        # block-buffered whenever it is not a terminal, so an unflushed line reaches the log only
        # when the process exits, which is exactly when nobody needs it any more.
        for tool in ('siteimg.py', 'shots.py'):
            src = (ROOT / 'tools' / tool).read_text(encoding='utf-8')
            self.assertIn('print(*a, flush=True, **k)', src, f'{tool}: progress can sit in a buffer')
            # A line naming the unit before the work starts. The shape changed when the renders went
            # parallel - a half-line with end="" cannot survive interleaving - so what is asserted is
            # the requirement: something is said, naming the shot, before the render is called.
            self.assertIn(' …"', src, f'{tool}: nothing is said before the work begins')
            self.assertLess(src.index(' …"'), src.index('time.monotonic()'),
                            f'{tool}: the start line comes after the clock, so it is not a start line')
            self.assertIn('time.monotonic()', src, f'{tool}: nothing says how long a unit took')
            self.assertNotIn('\n    print(f"  {key:20}', src, f'{tool}: an unflushed print is back')

    def test_it_says_when_the_listing_pictures_are_of_another_version(self):
        # The screenshots on the listing are pictures of an interface, and a release that changed one
        # has to replace them. That step lived only in the routine - so it depended on somebody
        # remembering it at the end of a long day, and it was missed on exactly the release that
        # changed both interfaces: Analytics was carrying 1.23.0's pictures into 1.26.0 and the CRM's
        # set had no recorded version at all. Reported as a rule: «it is not for me to have to ask you,
        # it is something the machine does».
        #
        # What is asserted is the derivation, not the wording: the version the listing records
        # against the version being tagged, and the note only when they differ - a reminder that
        # fires every time is one nobody reads.
        sh = (ROOT / 'tools/release.sh').read_text(encoding='utf-8')
        self.assertIn('screenshots.json', sh, 'nothing reads what the listing carries')
        self.assertIn('if [ "$SHOTS_VER" != "$VERSION" ]', sh,
                      'the reminder is unconditional, so it is noise on every release that needs none')
        self.assertIn('tools/shots.py', sh, 'it does not name the command that renders them')
        self.assertIn('$SHOTS_NOTE', sh, 'the note is built and never printed')

    def test_a_missing_browser_is_a_skip_and_not_a_verdict(self):
        # `CHROME = _chrome()` ran at import and `_chrome()` exits when it finds nothing, so on a
        # machine without a browser the whole Python battery collapsed - thirty errors and a failure,
        # measured, and an outside reviewer cloning the repository had to work out whether the product
        # was broken or a browser was missing. A verdict that depends on the machine is the thing this
        # repository refuses everywhere else, and the suite already knew how to say «skipped».
        #
        # Asserted on the source because the alternative is re-importing a module mid-suite: what
        # matters is that resolving happens in a function, that there is a way to ask without dying,
        # and that the only exit is inside the resolver.
        src = (ROOT / 'tools/shots.py').read_text(encoding='utf-8')
        self.assertNotIn('\nCHROME = _chrome()', src, 'Chrome is resolved at import again')
        self.assertIn('def chrome()', src, 'nothing resolves it on demand')
        self.assertIn('def have_chrome()', src, 'nothing can ask without being exited on')
        self.assertEqual(src.count('sys.exit("no Chrome found'), 1,
                         'the exit is in more than one place, so one of them will be reached by an import')
        # and it answers rather than raises, whatever this machine has
        sys.path.insert(0, str(ROOT / 'tools'))
        import shots
        self.assertIn(shots.have_chrome(), (True, False), 'have_chrome() does not answer a question')

    def test_what_both_windows_compute_identically_lives_in_one_file(self):
        # The two graph windows are different shapes with identical arithmetic, and that cost a double
        # edit on nearly every change: over one day of layout work, twenty functions were touched and
        # twelve had to be typed twice. graphlogic.js holds the shared half, and **what belongs in it
        # is derived rather than listed** - byte-identical in both products and touching no DOM handle.
        #
        # Which is what this asserts, because a hand-kept list is a checklist wearing a script's
        # clothes: it only ever holds the mistakes already made. A function that becomes shared
        # tomorrow fails here without anyone remembering it should.
        import re
        DOM = re.compile(r"document\.|\$\(|classList|\.style|appendChild|innerHTML|textContent"
                         r"|getElementById|querySelector|addEventListener|createElement")
        wins = {a: twincheck.functions((ROOT / 'apps' / a / 'graphview.js').read_text(encoding='utf-8'))
                for a in ('crm', 'analytics')}

        def touches_page(fns):
            """Names that reach the page, directly or through another function of the same window.

            Directly was the whole test, and it under-read: `onErArrSave` writes nothing itself and
            calls `erHint`, which writes the window's own hint line. It came out as «identical and
            touching no page», so the case asked for it to be moved into the DOM-free shared file -
            where `erHint`, `erIds` and `curView` do not exist. **A one-level heuristic answers a
            transitive question**, and the fix is the closure rather than a wider pattern: reach is
            what is being asked about, so compute reach.
            """
            hits = {n for n, body in fns.items() if DOM.search(body)}
            changed = True
            while changed:
                changed = False
                for n, body in fns.items():
                    if n in hits:
                        continue
                    if any(re.search(r'(?<![.\w])%s\s*\(' % re.escape(h), body) for h in hits):
                        hits.add(n)
                        changed = True
            return hits

        page = touches_page(wins['crm']) | touches_page(wins['analytics'])
        shared = set(wins['crm']) & set(wins['analytics'])
        stragglers = sorted(n for n in shared
                            if wins['crm'][n] == wins['analytics'][n] and n not in page)
        self.assertEqual(stragglers, [],
                         'these are identical in both windows and touch no page, so they belong in '
                         'graphlogic.js where one edit serves both: ' + ', '.join(stragglers))
        # and the two copies of the shared file are the same file, which is what makes editing one
        # of them and copying it across a mechanical step rather than a second act of typing
        crm = (ROOT / 'apps/crm/graphlogic.js').read_bytes()
        ana = (ROOT / 'apps/analytics/graphlogic.js').read_bytes()
        self.assertEqual(crm, ana, 'the two graphlogic.js have drifted')
        self.assertGreater(len(crm), 10000, 'graphlogic.js has been emptied')

    def test_the_gates_are_in_ci_and_not_only_on_this_machine(self):
        # The suite and auditcheck ran in tools/release.sh and nowhere else, so they were gates on
        # the machine that types the tag rather than on the tag: `git tag && git push --follow-tags`
        # from muscle memory, or from a checkout that never ran them, and CI would build, sign and
        # publish a Release of a commit nobody had verified. Provenance guaranteed by the machine,
        # quality by convention. Reported in a review of the chain, and true.
        wf = (ROOT / '.github/workflows/release.yml').read_text(encoding='utf-8')
        self.assertIn('bash tests/run.sh', wf, 'the suite does not run in CI')
        self.assertIn('tools/auditcheck.py --before-tag', wf, 'the claims are not checked in CI')
        # and before anything public exists, or they are a report rather than a gate
        self.assertLess(wf.index('bash tests/run.sh'), wf.index('Build twice'),
                        'the suite runs after the build, so a red suite still produces an archive')
        self.assertLess(wf.index('auditcheck'), wf.index('Publish the Release'),
                        'the claims are checked after the Release is published')

    def test_release_sh_does_not_send_the_human_to_do_the_machine_s_job(self):
        # store-upload.yml puts the archive on the item as a draft by itself, on workflow_run. The
        # printed steps still said «DOWNLOAD the .zip asset and upload THAT», which is the pattern
        # this repository has already corrected between two pages - two descriptions of two different
        # release chains - this time inside the tool's own output.
        sh = (ROOT / 'tools/release.sh').read_text(encoding='utf-8')
        self.assertNotIn('DOWNLOAD the .zip asset', sh,
                         'the steps still tell the reader to upload what store-upload already did')
        self.assertIn('draft', sh, 'nothing says the package arrives on its own')
        self.assertIn('Submit for review', sh, 'the one human decision is not named')

    def test_the_workflow_reads_the_same_path(self):
        # One path, two readers: the tagging step and the workflow that publishes. If they disagree,
        # release.sh passes and the run fails after the tag is public.
        wf = (ROOT / '.github/workflows/release.yml').read_text(encoding='utf-8')
        self.assertIn('store/$APP/whatsnew/$VERSION.md', wf)
        sh = (ROOT / 'tools/release.sh').read_text(encoding='utf-8')
        self.assertIn('store/$APP/whatsnew/$VERSION.md', sh)
        # Only body_path: `body` and `body_path` together leave it to the action which one wins.
        # `--notes-file` since the publish moved from a JavaScript action to gh; `body_path:` was the
        # action's spelling of the same thing.
        self.assertIn('--notes-file', wf)
        self.assertNotIn('body: |', wf)

    # Where the convention starts, per app, stated once with the reason — the same posture as
    # RELEASES.md recording that CRM 0.13.8 has no commit and Analytics 1.0.0 no hash. Everything at
    # or after these versions must carry notes; what came before was released without the practice
    # existing, and inventing notes for it now would be writing history rather than recording it.
    # A version listed and a file missing is a finding, so nothing here can go quiet by omission.
    NOTES_FROM = {'crm': (1, 38, 4), 'analytics': None}   # analytics: not yet released under it

    def test_every_release_since_the_convention_has_notes(self):
        rows = 0
        for line in (ROOT / 'RELEASES.md').read_text(encoding='utf-8').split('\n'):
            c = [x.strip().strip('`') for x in line.split('|')]
            if len(c) < 7 or c[1] not in ('crm', 'analytics'):
                continue
            if not re.fullmatch(r'\d+\.\d+\.\d+', c[2] or ''):
                continue
            floor = self.NOTES_FROM[c[1]]
            if floor is None or tuple(int(x) for x in c[2].split('.')) < floor:
                continue
            rows += 1
            self.assertTrue((ROOT / f'store/{c[1]}/whatsnew/{c[2]}.md').is_file(),
                            f'{c[1]} {c[2]} is in the ledger with no release notes at '
                            f'store/{c[1]}/whatsnew/{c[2]}.md')
        self.assertTrue(rows, 'no ledger row was checked — the parse or the floors are wrong')


class EveryWorkerRouteStillReachesTheWorker(unittest.TestCase):
    """Turning on a 404 page silently took `/api/versions` away.

    `assets.not_found_handling` stops a request that matches no asset from reaching the Worker at
    all - and `/api/versions` matches no asset, so the endpoint answered the 404 page, for a `fetch`
    as well as for a navigation. The footer badge and the guides' version stamp were dead on every
    page of the site and nothing said so: the deploy succeeded, every page rendered, and the one
    thing that broke is the one thing that fails quietly by design.

    It was verified on a preview beforehand - against `/docs` and `/llms.txt`, the routes I happened
    to think of. The list has to be derived from the script instead, which is what this does: every
    path `_worker.js` handles before falling through to `env.ASSETS` must be covered by
    `run_worker_first`, or the asset layer answers first and the Worker never runs.
    """

    def setUp(self):
        self.worker = (ROOT / 'site/_worker.js').read_text(encoding='utf-8')
        self.cfg = (ROOT / 'site/wrangler.jsonc').read_text(encoding='utf-8')
        self.first = re.findall(r'"run_worker_first":\s*\[([^\]]*)\]', self.cfg)
        self.first = re.findall(r'"([^"]+)"', self.first[0]) if self.first else []

    def _covered(self, path):
        for pat in self.first:
            if pat.endswith('/*') and path.startswith(pat[:-1]):
                return True
            if pat == path:
                return True
        return False

    def test_the_api_route_is_covered(self):
        routes = re.findall(r"url\.pathname === '([^']+)'", self.worker)
        self.assertTrue(routes, 'no exact route found in _worker.js - has the dispatch changed?')
        for r in routes:
            self.assertTrue(self._covered(r),
                            f'{r} is handled by _worker.js but is not in run_worker_first; with '
                            f'not_found_handling set, the asset layer answers it with the 404 page')

    def test_every_redirect_source_is_covered(self):
        block = re.search(r'const MOVED = \{(.*?)\}', self.worker, re.S).group(1)
        for src in re.findall(r"'(/[^']*)':", block):
            self.assertTrue(self._covered(src),
                            f'{src} redirects via the Worker but never reaches it')

    def test_every_binding_the_worker_reads_is_declared(self):
        # The failure mode this exists for is silence: read `env.CF_VERSION` without declaring
        # `version_metadata` and the value is simply undefined for ever - no error, no log, and a
        # footer that quietly stops dating the site. The same shape as the routes above.
        #
        # A secret is deliberately *not* in this file - committing it would publish it - so the
        # remainder after the declared bindings must be exactly the secrets, named here. Declaring
        # one is a deliberate act; forgetting is what gets reported.
        #
        # It is empty, and that is the point: the Worker used to read `CWS_SERVICE_ACCOUNT`, a
        # service-account key that can publish to the Chrome Web Store, sitting in Cloudflare where
        # request-handling code could read it. `tools/storestatus.py` asks Google from a workflow
        # now and writes the answer to KV, which the Worker reads through a binding - and a binding
        # is declared in the config this test already reads, so it lands in `declared` and never
        # here. **A name reappearing here means a credential has come back into a web-facing
        # runtime**, which is a decision, not a detail.
        # Three came back with /api/report, and this is the decision being recorded rather than
        # slipped in. The endpoint turns a report the reader has already seen into a public issue,
        # so it needs to prove the caller is human and to post as somebody.
        #   TURNSTILE_SECRET  verifies the captcha. Useless to a thief on its own.
        #   REPORT_SALT       salts the per-IP rate-limit hash, so KV holds no address. Optional:
        #                     it falls back to the Turnstile secret, which is why it is not required.
        #   GH_TOKEN          the one that matters. It must be a **fine-grained** token whose only
        #                     permission is `issues: write` on ivannot/zoost - no code, no releases,
        #                     no other repository, no account scope. With that shape the worst a
        #                     compromised Worker can do is open issues on a public tracker, which is
        #                     already something anyone with a GitHub account can do by hand.
        # The endpoint refuses outright when either required secret is missing, so a misconfigured
        # deploy cannot serve an unprotected write path.
        SECRETS = {'TURNSTILE_SECRET', 'GH_TOKEN', 'REPORT_SALT'}
        read = set(re.findall(r'\benv\.([A-Z][A-Z0-9_]*)', self.worker))
        declared = set(re.findall(r'"binding":\s*"([^"]+)"', self.cfg))
        self.assertTrue(read, 'nothing is read off env - has the signature changed?')
        self.assertEqual(read - declared, SECRETS,
                         'a name read off env is neither declared in wrangler.jsonc nor a known '
                         'secret: declare the binding, or add it to SECRETS if it is one')

    def test_the_report_endpoint_refuses_when_it_is_not_configured(self):
        # A write path to a public repository with its captcha switched off is worse than a missing
        # feature, so «not configured» must fail closed. Read from the source because the guard is
        # the first thing in the handler and its order is what makes it a guard.
        fn = self.worker[self.worker.index('async function report('):]
        fn = fn[:fn.index('\n}')]
        self.assertIn("!env.TURNSTILE_SECRET || !env.GH_TOKEN", fn)
        self.assertLess(fn.index('TURNSTILE_SECRET'), fn.index('siteverify'),
                        'the configuration check runs after the captcha call, so an unconfigured '
                        'deploy would still reach out')
        self.assertLess(fn.index('siteverify'), fn.index('api.github.com'),
                        'the issue is created before the captcha is verified')

    def test_the_report_endpoint_never_passes_text_through(self):
        fn = self.worker[self.worker.index('async function report('):]
        fn = fn[:fn.index('\n}')]
        # Every place the user's text reaches the issue goes through both, in this order.
        self.assertIn('reportRedact(text)', fn)
        self.assertIn('reportRedact(says)', fn)
        self.assertIn('reportFence(clean)', fn)
        self.assertNotIn('body: text', fn)

    def test_a_hand_written_report_is_never_dressed_as_a_trace(self):
        # The page grew a path for somebody with no panel and no GitHub account: they describe the
        # problem in their own words. The danger is not the text, it is the *frame* - an issue titled
        # «Panel report» carrying a description reads as evidence, and a diagnosis built on that is
        # the same failure as a quietly edited trace, one door along.
        fn = self.worker[self.worker.index('async function report('):]
        fn = fn[:fn.index('\n}')]
        self.assertIn("const hand = (body && body.hand) === true;", fn)
        self.assertIn("'Written by hand: '", fn)
        self.assertIn("labels: hand ? ['from-page']", fn)
        # Its notes are the whole of it, so an empty one is nothing to send - checked before the
        # limiter is touched, like every other shape check.
        self.assertIn("if (hand && !says.trim())", fn)
        self.assertLess(fn.index('hand && !says.trim()'), fn.index('reportRateKey'),
                        'an empty hand-written report spends a slot of the daily limit')
        # And it must not carry the trace fence: there is no trace, and an empty fenced block above
        # a description is the page saying it has evidence it does not have.
        self.assertIn('hand ? reportFence(extra) : reportFence(clean)', fn)

    def test_the_fence_cannot_be_climbed_out_of(self):
        # A report containing a fence would end the block and the rest would render as markdown -
        # which is how a link, an image or an HTML comment gets into an issue nobody wrote.
        out = subprocess.run(
            ['node', '-e', """
             const src = require('fs').readFileSync('site/_worker.js', 'utf8');
             const fn = src.slice(src.indexOf('function reportFence'));
             eval(fn.slice(0, fn.indexOf('\\n}') + 2));
             const evil = 'x\\n```\\n<img src=x onerror=alert(1)>\\n```';
             const out = reportFence(evil);
             const fences = (out.match(/```/g) || []).length;
             console.log(JSON.stringify({ fences, has: /`{3}/.test(out.slice(4, -4)) }));
             """],
            capture_output=True, text=True, cwd=str(ROOT))
        self.assertEqual(out.returncode, 0, out.stderr)
        got = json.loads(out.stdout)
        self.assertEqual(got['fences'], 2, 'the content still carries a fence of its own')
        self.assertFalse(got['has'], 'a backtick run survived inside the block')

    def test_the_two_redactions_agree(self):
        # The panel redacts and the Worker redacts again, deliberately as two copies - shared code
        # between a client and the thing that distrusts it lets one edit switch off both. What they
        # may not do is *disagree*, or the second pass would be theatre.
        out = subprocess.run(
            ['node', '-e', """
             const fs = require('fs');
             const w = fs.readFileSync('site/_worker.js', 'utf8');
             const p = fs.readFileSync('apps/crm/sidepanel.js', 'utf8');
             const wf = w.slice(w.indexOf('function reportRedact'));
             eval(wf.slice(0, wf.indexOf('\\n}') + 2));
             const pf = p.slice(p.indexOf('function redact('));
             eval(pf.slice(0, pf.indexOf('\\n}') + 2));
             const cases = ['mail a@b.co', 'org 349725000131663089', 'to \\u00abAcme\\u00bb now',
                            'said "secret"', 'GET https://crm.zoho.eu/x', 'plain words'];
             console.log(JSON.stringify(cases.map((c) => [reportRedact(c), redact(c).text])));
             """],
            capture_output=True, text=True, cwd=str(ROOT))
        self.assertEqual(out.returncode, 0, out.stderr)
        for worker_said, panel_said in json.loads(out.stdout):
            self.assertEqual(worker_said, panel_said,
                             'the Worker and the panel disagree about what is sensitive')

    def test_a_404_page_is_configured_at_all(self):
        # If this is ever removed the rules above stop mattering - and the reader should be told why
        # they exist rather than finding an inexplicable list.
        self.assertIn('"not_found_handling"', self.cfg)

    def test_the_check_can_fail(self):
        saved = self.first
        try:
            self.first = ['/llms.txt']
            self.assertFalse(self._covered('/api/versions'))
            self.assertTrue(self._covered('/llms.txt'))
            self.first = ['/api/*']
            self.assertTrue(self._covered('/api/versions'))
        finally:
            self.first = saved


class NoPageKeepsItsOwnStyle(unittest.TestCase):
    """No page carries a `<style>` block, which is the stronger form of a rule this file used to hold.

    What was here before compared each landing page's inline `<style>` with its translation's, because
    an audit had found the pair already coming apart - `it/index.html` was missing one comment. No rule
    differed, so nothing looked wrong; the point was that whatever drops a comment will drop a rule.

    The pages have no inline style left at all now: 210 lines of copy across fourteen pages became
    rules in `site.css`, verified by photographing all 23 pages before and after. So the divergence
    this guarded against cannot happen, and what is worth holding is the absence itself - the moment
    one page grows a `<style>` again, the copying starts again with it.

    The four things that genuinely differ per page are `--sel` and friends, and they are a class on
    <body> now: `body.crm`, `body.analytics`, `body.lp`.
    """

    def test_no_page_carries_an_inline_style_block(self):
        offenders = []
        for p in sorted((ROOT / 'site').rglob('*.html')):
            if re.search(r'<style[^>]*>', p.read_text(encoding='utf-8')):
                offenders.append(p.relative_to(ROOT).as_posix())
        self.assertEqual(offenders, [], 'a page has grown a stylesheet of its own again; '
                                        'site.css is where a rule lives, and tools/csscheck.py says why')

    def test_the_product_accent_is_a_class_on_body(self):
        for page, cls in (('site/crm.html', 'crm'), ('site/analytics.html', 'analytics'),
                          ('site/docs-crm.html', 'crm'), ('site/it/analytics.html', 'analytics')):
            body = re.search(r'<body[^>]*>', (ROOT / page).read_text(encoding='utf-8')).group(0)
            self.assertIn(cls, body, f'{page}: nothing says which product this page is about')
        css = (ROOT / 'site/site.css').read_text(encoding='utf-8')
        for cls in ('body.crm{', 'body.analytics{'):
            self.assertIn(cls, css, f'{cls} is not defined, so the class on <body> buys nothing')


class DatesAreDerived(unittest.TestCase):
    """No date a reader sees may be a keystroke.

    A typed date is unverifiable by construction and free to disagree with the record it describes,
    which is the whole reason `RELEASES.md` no longer carries a Submitted column: GitHub timestamps
    the tag, Google reports the state, Cloudflare reports the deployment, and «when I clicked Submit»
    is held by nothing. What is printed is written by `tools/stamp.py` inside a `data-stamp` element;
    everything else is reported.
    """

    def find(self, name, text):
        findings = []
        f = ROOT / 'site' / name if name.endswith('.html') else ROOT / name
        orig = f.read_text(encoding='utf-8')
        try:
            f.write_text(text, encoding='utf-8')
            sitecheck.no_date_is_typed(findings)
        finally:
            f.write_text(orig, encoding='utf-8')
        return [x for x in findings if name in x]

    def test_a_typed_date_is_reported(self):
        self.assertTrue(self.find('404.html', '<p>Updated 4 March 2026</p>'))
        self.assertTrue(self.find('404.html', '<p>2026-03-04</p>'))

    def test_a_stamped_date_is_not(self):
        self.assertFalse(self.find('404.html', '<p><span data-stamp="updated">4 March 2026</span></p>'))

    def test_indented_markup_is_still_read(self):
        # The first version stripped four-space-indented lines as Markdown code blocks, and applied
        # that to HTML too - where nearly every line is indented. It blanked most of every page and
        # reported zero across the whole site. Found by mutating a page and getting nothing back,
        # which is the only way this class of silence is ever found.
        self.assertTrue(self.find('404.html', '<div>\n    <div>\n        <p>4 March 2026</p>\n    </div>\n</div>'))

    def test_a_value_in_code_is_not_a_claim(self):
        # `anthropic-version: 2023-06-01` is a constant, not an assertion about when anything happened.
        self.assertFalse(self.find('404.html', '<pre>2026-03-04</pre>'))
        self.assertFalse(self.find('404.html', '<p><code>4 March 2026</code></p>'))


def shallow_clone() -> bool:
    """Is this checkout missing its history? Then a check derived from git cannot be run.

    Not an excuse: two checks here are *derived from the repository's history* - the sitemap's
    lastmod per file, and what `whatsnew.py` reports since a tag - and in a `--depth 1` clone both
    are asking questions the clone cannot answer. They failed the first release that ran the battery
    in CI, where checkout is shallow by default, and passed on every machine with a real clone: a
    verdict that depends on how the repository was fetched. The workflow now fetches the lot; this
    is the other half, so that anybody with a shallow clone is told which it is.
    """
    out = subprocess.run(['git', 'rev-parse', '--is-shallow-repository'],
                         cwd=ROOT, capture_output=True, text=True)
    return out.stdout.strip() == 'true'


class SitemapIsDerived(unittest.TestCase):
    """Every field in the sitemap was typed by hand, and the dates had drifted three days behind.

    Google uses `<lastmod>` "if it's consistently and verifiably accurate (for example by comparing
    to the last modification of the page)" — so stale dates do not cost one row, they cost the field
    across the file. Ours were wrong at the one moment it mattered: the canonical fix had just
    rewritten every page and the sitemap still said nothing had changed.
    """

    def test_the_committed_file_is_what_the_site_derives(self):
        if shallow_clone():
            self.skipTest('shallow clone - lastmod is derived from each file\'s history, which is not here')
        out = subprocess.run([sys.executable, str(ROOT / 'tools/sitemap.py'), '--check'],
                             capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stdout)

    def test_the_url_is_the_served_one_not_the_file_name(self):
        self.assertEqual(sitemap.url_of('crm.html'), 'https://zoost.it/crm')
        self.assertEqual(sitemap.url_of('it/crm.html'), 'https://zoost.it/it/crm')
        self.assertEqual(sitemap.url_of('index.html'), 'https://zoost.it/')
        self.assertEqual(sitemap.url_of('it/index.html'), 'https://zoost.it/it/')
        self.assertEqual(sitemap.url_of('llms.txt'), 'https://zoost.it/llms.txt')

    def test_it_writes_no_field_google_ignores(self):
        xml = sitemap.build()
        self.assertNotIn('<priority>', xml, 'Google ignores priority; a field nobody reads only rots')
        self.assertNotIn('<changefreq>', xml)

    def test_every_lastmod_is_a_date(self):
        self.assertTrue(re.fullmatch(r'\d{4}-\d{2}-\d{2}', sitemap.lastmod('crm.html')))

    def test_the_home_comes_first(self):
        self.assertEqual(sitemap.pages()[0], 'index.html')

    def test_a_page_with_no_translation_carries_no_alternates(self):
        # Deriving the pair from the twin's existence is what stops a new page shipping without it -
        # and what stops one being claimed where there is nothing to point at.
        xml = sitemap.build()
        block = [b for b in xml.split('<url>') if '<loc>https://zoost.it/llms.txt</loc>' in b]
        self.assertEqual(len(block), 1, xml[:400])
        self.assertNotIn('hreflang', block[0])


class DeployStateIsPartOfTheAudit(unittest.TestCase):
    """«Fixed» must not mean «fixed in a tree nobody else can see».

    Four commits sat unpushed while the fix in them was reported as done — true of the working tree,
    false of the page the user was looking at, and he found it by opening the site. The mechanism was
    `--offline`, which skips the live comparison and reported the skip as a quiet note among the
    passes, so a run that proved nothing about zoost.it still ended in «0 findings».
    """

    def test_offline_is_a_finding_not_a_note(self):
        out = subprocess.run([sys.executable, str(ROOT / 'tools/auditcheck.py'), '--offline'],
                             capture_output=True, text=True)
        self.assertIn('the live site was not looked at', out.stdout)
        self.assertNotEqual(out.returncode, 0, '--offline must never be able to end in success')

    def test_it_asks_git_rather_than_the_network(self):
        src = (ROOT / 'tools/auditcheck.py').read_text(encoding='utf-8')
        self.assertIn("'rev-list', '--count', '@{upstream}..HEAD'", src)
        self.assertIn('are not pushed', src)


class TheLedgerIsWrittenInThePast(unittest.TestCase):
    """A record that is appended to and never revised may not describe the present.

    `RELEASES.md` said «1.0.0 - the version the Store is serving today», which was true the day it
    was written and false a week later, in the one section that already documents two corrections to
    itself. The defect is not the sentence, it is the tense: a document nobody re-reads cannot carry
    a claim that has to be maintained. What is current is on zoost.it, read from the Store's own API.

    Reported by a reader, which is the failure - so it is a check now rather than a resolution.
    """

    TEMPORAL = ('today', 'currently', 'right now', 'at the moment', 'as of writing', 'these days',
                'is serving', 'is being served')

    def test_no_sentence_has_to_be_maintained(self):
        text = (ROOT / 'RELEASES.md').read_text(encoding='utf-8')
        # Code fences hold commands, where «today» would be part of an example rather than a claim.
        prose = re.sub(r'```[\s\S]*?```', '', text).lower()
        hits = [w for w in self.TEMPORAL if w in prose]
        self.assertEqual(hits, [], f'RELEASES.md speaks in the present tense: {hits}')


class ADeployDoesNotLandEverywhereAtOnce(unittest.TestCase):
    """A difference found seconds after a push is propagation, not a stale deploy.

    `auditcheck` ran twice within a minute of two pushes and reported one file each time -
    `crm-preview.webp`, then `index.html` - and both matched a moment later. Reporting that as a
    stale deploy is how a check stops being read; not reporting a stale deploy is what the check
    exists for. So a difference is fetched once more before it becomes a finding, and a file that is
    genuinely wrong is still wrong ten seconds later - nothing real is hidden by the wait.
    """

    def test_a_difference_is_fetched_twice_before_it_is_reported(self):
        src = (ROOT / 'tools/auditcheck.py').read_text(encoding='utf-8')
        self.assertIn('time.sleep(10)', src, 'the second fetch has to wait, or it proves nothing')
        self.assertIn('and again ten seconds later', src)
        self.assertIn('still propagating', src)
        # The point is that no mismatch can reach `findings` without passing the second fetch.
        self.assertNotIn("findings.append(f'{rel}: {url} does not contain", src)
        self.assertNotIn("findings.append(f'{rel}: {url} returned an empty body", src)


class TheStoreScreenshotsAreOrderedAndNumbered(unittest.TestCase):
    """Five slots, no names, and the order is the argument.

    The Chrome Web Store takes at most five screenshots, shows them in upload order and calls them
    nothing - so the file name carries the order and nothing else, `crm_1.png` .. `crm_5.png`, and
    the first is the interface with a workspace open, because that is the thumbnail. The Analytics
    listing sat on a single image from its first submission because nothing said otherwise.
    """

    def setUp(self):
        sys.path.insert(0, str(ROOT / 'tools'))
        import shots
        self.shots = shots
        self.keys = {s[0] for s in shots.SHOTS + shots.PANELS + shots.OPTIONS}

    def test_every_published_key_is_a_shot_that_exists(self):
        for app, keys in self.shots.STORE.items():
            for k in keys:
                self.assertIn(k, self.keys, f'{app}: {k} is published and nothing renders it')

    def test_at_most_five_and_the_first_is_the_interface(self):
        for app, keys in self.shots.STORE.items():
            self.assertLessEqual(len(keys), 5, f'{app}: the Store takes five')
            self.assertEqual(len(set(keys)), len(keys), f'{app}: a slot is filled twice')
            panels = {s[0] for s in self.shots.PANELS}
            self.assertIn(keys[0], panels,
                          f'{app}: the first slot is the panel over a workspace, not {keys[0]}')

    def test_the_ledger_says_what_was_uploaded(self):
        for app in self.shots.STORE:
            f = ROOT / 'store' / app / 'screenshots.json'
            self.assertTrue(f.exists(), f'{app}: nothing records which set is on the Store')
            rec = json.loads(f.read_text(encoding='utf-8'))
            for k in ('version', 'digest', 'files'):
                self.assertIn(k, rec, f'{app}: the ledger has no {k}')
            # A folder per product, the files named by slot only: uploading is opening one folder
            # and taking what is in it, in order.
            self.assertEqual(rec['files'],
                             [f'{n}.png' for n in range(1, len(self.shots.STORE[app]) + 1)])
            self.assertEqual(rec['folder'], f'dist/store/{app}/')

    def test_a_failed_viewport_probe_reports_the_driver_error(self):
        # `check=True` used to replace capture.mjs' useful stderr with a bare CalledProcessError.
        # That made a missing WebSocket runtime look like an unexplained browser failure.
        proc = mock.Mock()
        measured = subprocess.CompletedProcess([], 1, stdout='', stderr='WebSocket is not defined')
        sock = mock.MagicMock()
        sock.__enter__.return_value.getsockname.return_value = ('127.0.0.1', 41234)
        self.shots._browser = None
        with mock.patch.object(self.shots.tempfile, 'mkdtemp', return_value='/tmp/zoost-probe-test'), \
             mock.patch.object(self.shots.socket, 'socket', return_value=sock), \
             mock.patch.object(self.shots, 'chrome', return_value='chrome'), \
             mock.patch.object(self.shots, '_ws_url', return_value='ws://probe'), \
             mock.patch.object(self.shots.subprocess, 'Popen', return_value=proc), \
             mock.patch.object(self.shots.subprocess, 'run', return_value=measured):
            with self.assertRaisesRegex(RuntimeError, 'WebSocket is not defined'):
                self.shots._browser_for(1280, 800, 1.0)
        proc.terminate.assert_called_once()
        proc.wait.assert_called_once_with(timeout=10)


class ReadingJavaScriptWithoutAParser(unittest.TestCase):
    """The scanner two checkers depend on, checked against every file they read.

    `re.sub(r'/\\*.*?\\*/', ...)` cannot tell a block comment from the `/*` inside
    `'https://crm.zoho.eu/*'`, which is line 5 of the CRM panel: 48 of its 217 function declarations
    were invisible to `twincheck` and to `namecheck`, silently, for as long as both have existed.
    The replacement was wrong too on its first try - it ended a template literal at the first
    backtick and this codebase nests them - and that failure was equally silent.

    So the property is asserted rather than the implementation: stripping may not lose a declaration,
    and may not leave commentary behind. Both bugs are caught by it.
    """

    def setUp(self):
        sys.path.insert(0, str(ROOT / 'tools'))
        from jstext import strip_js
        self.strip = strip_js

    def test_no_declaration_is_lost_and_no_comment_survives(self):
        decl = lambda t: len(re.findall(r'^(?:async )?function (\w+)\s*\(', t, re.M))
        for f in sorted(ROOT.glob('apps/*/*.js')):
            js = f.read_text(encoding='utf-8')
            out = self.strip(js)
            rel = f.relative_to(ROOT)
            self.assertEqual(decl(out), decl(js), f'{rel}: stripping lost a function declaration')
            left = [ln for ln in out.splitlines() if re.match(r'\s*(\*\s|//)', ln)]
            self.assertEqual(left[:1], [], f'{rel}: commentary survived the strip')

    def test_the_shapes_that_broke_it(self):
        # each of these was a real defect, in the source or in the scanner
        cases = [
            ("const H = ['https://crm.zoho.eu/*'];\nfunction after() {}", 'after'),
            ("const s = `a ${x ? `b` : ''} c`;\n// Zoho's own\nfunction after() {}", 'after'),
            ("const r = /^https:\\/\\/crm\\.([^/*]+)$/;\nfunction after() {}", 'after'),
        ]
        for src, name in cases:
            out = self.strip(src)
            self.assertIn(f'function {name}', out, f'the scanner swallowed code after: {src[:40]}')
            self.assertNotIn('//', out.replace('https://', ''))


class ImagesAreRenderedOnlyWhenSomethingMoved(unittest.TestCase):
    """Re-rendering what has not changed produces the same bytes, slowly.

    A full run was about three minutes of headless Chrome, every time, and most of it redrew images
    whose sources had not moved. The digest that already answered «is this picture still of the
    product» now decides whether to draw it at all - which flips the cost of being wrong: rendering
    something needlessly costs ten seconds, skipping something that changed publishes a picture of a
    product that no longer exists. So the hash has to cover everything that can change a pixel, the
    renderers included.
    """

    def setUp(self):
        sys.path.insert(0, str(ROOT / 'tools'))
        import shots, siteimg
        self.shots, self.siteimg = shots, siteimg

    def test_the_click_script_is_part_of_what_a_picture_is_of(self):
        a = self.siteimg.source_digest('crm', 'el.click();')
        b = self.siteimg.source_digest('crm', 'el.click(); other.click();')
        self.assertNotEqual(a, b, 'two shots of the same app would share a digest')

    def test_the_renderers_are_in_the_hash(self):
        # Read off the set the tool computes, not out of the text of `source_digest`. It used to
        # search that function's body for two file names - a photograph of the spelling, which said
        # nothing about what was hashed and went red the day the list became a derivation.
        names = {f.name for f in self.siteimg.renderers()}
        for f in ('shots.py', 'fsshim.js'):
            self.assertIn(f, names,
                          f'{f} decides how a shot is drawn and is not in the digest, so changing it '
                          f'would leave every image looking current')

    def test_the_upload_folder_holds_the_images_and_nothing_else(self):
        # The folder is opened and its contents uploaded in order; a stamp file among them is a file
        # somebody has to know to skip.
        stamp = self.shots.stamp_file('crm')
        folder = ROOT / 'dist' / 'store' / 'crm'
        self.assertNotEqual(stamp.parent, folder, 'the stamp sits among the images')
        if folder.exists():
            self.assertEqual(sorted(p.name for p in folder.iterdir()),
                             [f'{n}.png' for n in range(1, len(self.shots.STORE['crm']) + 1)])


class TheCardIsOneOfTheImages(unittest.TestCase):
    """`site/img/og.png` was outside every check that exists for the images, and not by decision.

    Four independent reasons, which is why removing any one of them would have changed nothing:
    `imgcheck` asks the renderer which images exist and the card is not one of its shots; the
    remaining checks read `<img>` tags and the card lives in a `<meta property="og:image">`; every
    set in the checker is globbed as `*.webp` and the card is a PNG; and `siteimg.py` rendered it
    unconditionally at the end of every run, so nothing recorded what it was drawn from. Its bytes
    changed between two machines and the only thing that noticed was `git status`.
    """

    def setUp(self):
        sys.path.insert(0, str(ROOT / 'tools'))
        import siteimg
        self.siteimg = siteimg

    def test_the_card_knows_what_it_is_made_of(self):
        # Derived from the template, not written down: point the card at another screenshot and a
        # hardcoded pairing would go on watching a file the card no longer contains.
        got = [p.name for p in self.siteimg.og_sources()]
        self.assertIn('ogcard.html', got)
        self.assertIn('crm-preview.webp', got, 'the screenshot the card embeds is not in its sources')
        for p in self.siteimg.og_sources():
            self.assertTrue(p.exists(), f'the card is composed from {p.name}, which does not exist')

    def test_the_screenshot_inside_the_card_is_part_of_its_digest(self):
        # The template alone would say the card is current while the picture inside it had changed.
        with tempfile.TemporaryDirectory() as tmp:
            shot = Path(tmp) / 'crm-preview.webp'
            shot.write_bytes(b'one')
            keep = self.siteimg.og_sources
            try:
                self.siteimg.og_sources = lambda: [shot]
                a = self.siteimg.og_digest()
                shot.write_bytes(b'two')
                b = self.siteimg.og_digest()
            finally:
                self.siteimg.og_sources = keep
        self.assertNotEqual(a, b, 'the embedded screenshot can change without the digest moving')

    def test_the_card_is_not_drawn_when_nothing_moved(self):
        src = (ROOT / 'tools/siteimg.py').read_text(encoding='utf-8')
        i = src.index('def main(')
        body = src[i:]
        guard = body.index('OG_KEY')
        self.assertLess(guard, body.index('render_og_card('),
                        'the card is drawn before the ledger is consulted, so it is drawn every run')

    def test_the_card_is_drawn_before_the_pages_are_stamped(self):
        # Each page carries the card's own bytes in og:image. Stamping first writes last run's
        # digest, and the run ends with every page pointing at a card that no longer exists.
        src = (ROOT / 'tools/siteimg.py').read_text(encoding='utf-8')
        body = src[src.index('def main('):]
        self.assertLess(body.index('render_og_card('), body.index('stamp_assets()'),
                        'the pages are stamped before the card they point at is drawn')

    def test_a_stale_card_is_a_finding(self):
        # The whole point: a card whose sources have moved must be reported rather than left for
        # `git status` to show. Only the card's row is broken, so nothing else in the run goes red.
        import imgcheck
        ledger = json.loads((ROOT / 'tools/imgstamp.json').read_text(encoding='utf-8'))
        self.assertIn(self.siteimg.OG_KEY, ledger, 'the card has no row in the ledger')
        ledger[self.siteimg.OG_KEY] = {'from': 'a1b2c3d4e5f60718'}
        with tempfile.TemporaryDirectory() as tmp:
            broken = Path(tmp) / 'imgstamp.json'
            broken.write_text(json.dumps(ledger), encoding='utf-8')
            keep, out = imgcheck.STAMP, io.StringIO()
            try:
                imgcheck.STAMP = broken
                with contextlib.redirect_stdout(out):
                    code = imgcheck.main()
            finally:
                imgcheck.STAMP = keep
        said = [l for l in out.getvalue().splitlines() if 'og.png' in l]
        self.assertEqual(code, 1, f'a stale card passed the check: {out.getvalue()}')
        self.assertTrue(said, f'the check went red about something else: {out.getvalue()}')


class OnlyWhatGoesInTheDashboardIsAPublicClaim(unittest.TestCase):
    """A store listing is a working document wrapped around the fields that get pasted into Google's
    dashboard, and the absolutes ledger used to read it whole. So a note we wrote to ourselves - one
    added the same day, about pasting §9 again - landed on a ledger of public claims and had to be
    reworded to avoid the word "every". The tail wagging the dog.

    The boundary is the numbered section, and getting that wrong has a precedent on these same files:
    `sitecheck` once *stripped* the fenced blocks and passed on prose it had never read. Narrowing to
    the fences alone would have made the mirror-image mistake, because `## 10. Data disclosures` is a
    table and a blockquote rather than a paste field - and that blockquote is where "Nothing is sent
    to the developer" is promised.
    """

    CLAIM = 'It never sends anything anywhere, in every case.'

    def listing(self, tmp, body):
        d = Path(tmp) / 'store' / 'example'
        d.mkdir(parents=True)
        f = d / 'store-listing.md'
        f.write_text(body, encoding='utf-8')
        return f

    def setUp(self):
        sys.path.insert(0, str(ROOT / 'tools'))
        import auditcheck
        self.auditcheck = auditcheck

    def test_a_claim_inside_a_numbered_section_is_read(self):
        with tempfile.TemporaryDirectory() as tmp:
            f = self.listing(tmp, f'# Title\n\n## 1. Item name\n\n```\n{self.CLAIM}\n```\n')
            self.assertIn(self.CLAIM, self.auditcheck.sentences(f),
                          'a claim in the copy that gets pasted is not being read')

    def test_the_same_claim_outside_the_sections_is_not(self):
        # Verbatim the same sentence, above the first section and in the trailing notes: neither is
        # something Google is ever shown.
        with tempfile.TemporaryDirectory() as tmp:
            f = self.listing(tmp, f'# Title\n\n{self.CLAIM}\n\n## 1. Item name\n\n```\nZoost.\n```\n\n'
                                  f'## Notes before submitting\n\n- {self.CLAIM}\n')
            read = ' '.join(self.auditcheck.sentences(f))
            self.assertNotIn('never sends anything', read,
                             'a note written to ourselves is being held as a public claim')

    def test_a_section_with_no_fence_is_still_outward(self):
        # §10 is checkboxes and a justification, not a paste field. Reading fenced blocks only would
        # have dropped it in silence, which is the whole failure mode being guarded against.
        with tempfile.TemporaryDirectory() as tmp:
            f = self.listing(tmp, f'# Title\n\n## 10. Data disclosures\n\n| a | b |\n|---|---|\n\n'
                                  f'> {self.CLAIM}\n')
            self.assertIn(self.CLAIM, ' '.join(self.auditcheck.sentences(f)),
                          'an unfenced dashboard field is no longer read')

    def test_a_blockquote_marker_is_markup_and_not_prose(self):
        # The justification under §10's checkboxes is a blockquote, and its `> ` used to land inside
        # the sentence - the ledger held «the rows > inside tables are never sent», so the marker was
        # part of the key of a real promise.
        with tempfile.TemporaryDirectory() as tmp:
            f = self.listing(tmp, '# Title\n\n## 10. Data disclosures\n\n| a | b |\n|---|---|\n\n'
                                  '> Nothing is sent to the developer, and the rows\n'
                                  '> inside tables are never sent.\n')
            read = ' '.join(self.auditcheck.sentences(f))
            self.assertIn('the rows inside tables are never sent', read)
            self.assertNotIn('>', read, 'the blockquote markup is being read as prose')

    def test_the_real_listings_still_parse(self):
        # The guard above is worth nothing if the pattern stops matching the files it exists for.
        for app in ('crm', 'analytics'):
            f = ROOT / 'store' / app / 'store-listing.md'
            n = len(self.auditcheck.NUMBERED.findall(f.read_text(encoding='utf-8')))
            self.assertGreaterEqual(n, 9, f'{app}: {n} numbered section(s) parsed out of the listing')

    def test_a_listing_that_parses_to_nothing_is_a_finding(self):
        # Narrowing the input is the moment a checker can start reporting nothing and calling it
        # clean: only additions are reported, so claims that vanish are invisible by construction.
        with tempfile.TemporaryDirectory() as tmp:
            self.listing(tmp, '# Title\n\nNo numbered section anywhere in this file.\n')
            keep = self.auditcheck.ROOT
            try:
                self.auditcheck.ROOT = Path(tmp)
                _, quiet = self.auditcheck.absolutes()
            finally:
                self.auditcheck.ROOT = keep
        self.assertTrue(quiet, 'a listing nothing could be read out of passed as clean')
        self.assertIn('store-listing.md', quiet[0])


class TheReleaseBodyHasTwoReaders(unittest.TestCase):
    """What changed, then how it was built - in that order, with a line between them.

    The body carries two things with different readers: the notes somebody who installed the
    extension wants, and the hash and commit somebody verifying the archive wants. Mixed, each reads
    the other's half looking for their own. The notes come first because more people want them, and
    the second half is under a heading so it can be skipped to.
    """

    def test_notes_first_then_a_rule_then_provenance(self):
        wf = (ROOT / '.github/workflows/release.yml').read_text(encoding='utf-8')
        i = wf.index('cat "$NOTES" > "$BODY"')          # the notes open the body
        j = wf.index('---', i)                          # then the rule
        k = wf.index('## Provenance', j)                # then the half that is about the archive
        h = wf.index('sha256', k)                       # and the hash is inside it, not above
        self.assertLess(i, j); self.assertLess(j, k); self.assertLess(k, h)

    def test_a_tag_can_be_republished_without_being_moved(self):
        """GitHub forced its runners onto Node 24, softprops/action-gh-release started failing with
        «self-signed certificate», and crm-v1.40.0 built, compared and attested cleanly with no
        Release at the end of it. A tag-triggered run executes the copy of this file the *tag* points
        at, so the only way to retry would have been to move a published ref.

        Two things make that unnecessary, and both have to stay: the workflow can be dispatched
        against an existing tag, and it checks that tag out rather than the branch - without the
        `ref`, a dispatched run builds whatever main holds and publishes it under the tag's name.
        """
        wf = (ROOT / '.github/workflows/release.yml').read_text(encoding='utf-8')
        self.assertIn('workflow_dispatch:', wf, 'a failed publish can only be retried by moving a tag')
        self.assertIn('ref: ${{ inputs.tag || github.ref }}', wf,
                      'a dispatched run would build the branch and call it the tag')
        i, j = wf.index('actions/checkout'), wf.index('Build twice')
        self.assertIn('inputs.tag', wf[i:j], 'the tag is not resolved before anything is built')

    def test_the_provenance_names_the_commit_that_was_built(self):
        """The first dispatched run published a Release saying the archive came from main. The bytes
        were right - the hash matched a local build of the tagged commit - and the sentence describing
        where they came from was wrong, which in a chain that exists to establish provenance is the
        worse half. `github.sha` is the branch head on a dispatched run, not what checkout took.
        """
        wf = (ROOT / '.github/workflows/release.yml').read_text(encoding='utf-8')
        body = wf[wf.index('Assemble the Release body'):]
        env = body[:body.index('run: |')]
        self.assertNotIn('github.sha', env, 'the provenance would name the branch on a dispatched run')
        self.assertNotIn('github.ref_name', env, 'the ref would be the branch on a dispatched run')
        self.assertIn('steps.tag.outputs.commit', env)
        self.assertIn('git rev-parse HEAD', wf, 'nothing records what was actually checked out')

    def test_publishing_does_not_depend_on_a_third_party_action(self):
        # The build, the double-build comparison and the attestation all passed; only the publish
        # died, and it died because of a runtime change nobody here made. gh is a Go binary already
        # on the runner.
        wf = (ROOT / '.github/workflows/release.yml').read_text(encoding='utf-8')
        publish = wf[wf.index('Publish the Release'):]
        self.assertNotIn('uses:', publish.split('\n      - name:')[0],
                         'the release is published by an action again')
        self.assertIn('--clobber', publish, 'a re-run cannot replace the asset, so it is not safe twice')

    def test_the_notes_are_required_rather_than_defaulted(self):
        wf = (ROOT / '.github/workflows/release.yml').read_text(encoding='utf-8')
        self.assertIn('if [ ! -s "$NOTES" ]', wf, 'a Release could be published with no notes')


class TheSampleWorkflowsActuallyFireSomething(unittest.TestCase):
    """A workflow action in the fixture has to resolve the way a real one does.

    It wrote `type: 'function'` where Zoho writes `functions`, and named the target
    «namespace.name» with an id of its own invention - so `resolveFn()` matched on neither and the
    sample workspace had **no workflow-to-function edge at all**: not in the call graph, not in the
    health audit's broken automations, not in the assistant's action counts. Nothing failed, because
    a filter that matches nothing looks exactly like an org that has nothing.

    Measured before and after through the panel: 0 workflows linked to a function, then 2.
    """

    def actions(self):
        base = sorted((ROOT / 'fixtures').glob('crm/*/workflows'))[0]
        idx = json.loads((base / 'index.json').read_text(encoding='utf-8'))
        out = []
        for row in idx:
            f = base / f"{row['id']}.json"
            if not f.exists():
                continue
            rule = json.loads(f.read_text(encoding='utf-8'))
            for c in rule.get('conditions') or []:
                out += ((c.get('instant_actions') or {}).get('actions') or [])
                for sa in c.get('scheduled_actions') or []:
                    out += sa.get('actions') or []
        return out

    def test_at_least_one_workflow_fires_a_function(self):
        fn = [a for a in self.actions() if a.get('type') == 'functions']
        self.assertGreaterEqual(len(fn), 2, 'no workflow in the sample fires a function, so the '
                                            'edge nine readers draw is never exercised')

    def test_both_forms_zoho_writes_are_recognised(self):
        # Counted in a real org's mirror: 149 actions of type `functions` and 2 of type `function`,
        # identical in shape. Nine readers compared against the plural only, so those two fired a
        # function nothing here ever knew about.
        src = (ROOT / 'apps/crm/sidepanel.js').read_text(encoding='utf-8')
        self.assertIn("const isFnAction = (a) => a && (a.type === 'functions' || a.type === 'function')", src)
        self.assertEqual(src.count("type === 'functions'"), 1,
                         'a reader still compares the type by hand instead of asking isFnAction()')
        kinds = {a.get('type') for a in self.actions()}
        self.assertIn('functions', kinds)
        self.assertIn('function', kinds, 'the fixture carries only the form that already worked')

    def test_actions_sit_where_zoho_puts_them(self):
        # The immediate ones go in `instant_actions.actions`. They were written to a bare `actions`
        # on the condition - a key nothing reads - so only the scheduled half ever had an action.
        base = sorted((ROOT / 'fixtures').glob('crm/*/workflows'))[0]
        seen = 0
        for f in base.glob('*.json'):
            if f.name == 'index.json':
                continue
            for c in json.loads(f.read_text(encoding='utf-8')).get('conditions') or []:
                self.assertNotIn('actions', {k for k in c if k == 'actions'},
                                 f'{f.name}: a bare `actions` on the condition is read by nothing')
                seen += len((c.get('instant_actions') or {}).get('actions') or [])
        self.assertGreater(seen, 0, 'no immediate action in the whole fixture')

    def test_exactly_one_action_is_deliberately_unresolvable(self):
        # Every other action has to resolve, or the graph is drawing edges from a coincidence; and
        # one has to not, or «broken automations» is a check with nothing to find. resolveFn() tries
        # the id first and then every name a function answers to.
        base = sorted((ROOT / 'fixtures').glob('crm/*/functions'))[0]
        idx = json.loads((base / 'index.json').read_text(encoding='utf-8'))
        by_id = {str(e.get('id')) for e in idx}
        by_name = {str(e.get(k)).lower() for e in idx for k in ('name', 'api_name', 'display_name') if e.get(k)}
        fn = [a for a in self.actions() if a.get('type') in ('functions', 'function')]
        missing = [a.get('name') for a in fn
                   if str(a.get('id')) not in by_id and str(a.get('name', '')).lower() not in by_name]
        self.assertEqual(len(missing), 1, f'expected one broken automation, found {missing}')

class TheSuiteRunsEverythingInIt(unittest.TestCase):
    """A test defined after `unittest.main()` is never run, and the suite still says OK.

    That happened here: six cases were appended below the trailer, and `python3 tests/tools_test.py`
    — which is what tests/run.sh calls — reported 78 passing while ignoring them. `unittest discover`
    found 84. A suite that goes quiet about part of itself is the same failure as a checker that goes
    quiet about a bug, and it is invisible because a number is the only thing that changes.

    Checked by reading the file, not by running it: the first version shelled out to this same file
    and recursed until it was killed.
    """

    def test_nothing_is_defined_below_the_trailer(self):
        # At the start of a line, not anywhere: the first occurrence of that text in this file is
        # inside this very test, so a naive search starts scanning from here and reports every class
        # written after it. The guard flagged itself the first time a class was added below it.
        src = (ROOT / 'tests/tools_test.py').read_text(encoding='utf-8')
        i = src.index("\nif __name__ == '__main__':")
        self.assertNotIn('\nclass ', src[i:], 'a class after the trailer is never run by run.sh')

    def test_every_case_in_the_file_is_loaded(self):
        src = (ROOT / 'tests/tools_test.py').read_text(encoding='utf-8')
        written = len(re.findall(r'^    def (test_\w+)', src, re.M))
        loaded = unittest.defaultTestLoader.loadTestsFromModule(sys.modules[__name__]).countTestCases()
        self.assertEqual(loaded, written,
                         f'{written} cases are written in the file and {loaded} are collected')


class TheLiveComparisonCoversEverythingPublished(unittest.TestCase):
    """"What is served is what is in the repository" was true of the prose and of nothing else.

    It compared .html and .txt, so site.css, site.js, the sitemap, the web manifest and every icon
    were never looked at - and it said 0 findings through a release that replaced fourteen PNGs and
    rewrote two scripts. The exclusions are read from .assetsignore, which is the list Cloudflare
    itself uses, rather than from a second copy kept in the tool.
    """

    def test_it_reads_assetsignore_rather_than_a_copy(self):
        src = (ROOT / 'tools/auditcheck.py').read_text(encoding='utf-8')
        self.assertIn('.assetsignore', src)

    def test_every_published_file_is_in_the_set(self):
        site = ROOT / 'site'
        ignored = {ln.strip() for ln in (site / '.assetsignore').read_text(encoding='utf-8').splitlines()
                   if ln.strip() and not ln.startswith('#')}
        want = {f.relative_to(site).as_posix() for f in site.rglob('*')
                if f.is_file() and f.name not in ignored and not f.name.startswith('.')
                and 'functions' not in f.relative_to(site).parts}
        for kind in ('site.css', 'site.js', 'sitemap.xml', 'favicon.ico', 'icon-512.png',
                     'site.webmanifest', 'it/privacy.html'):
            self.assertIn(kind, want, kind + ' would not be compared against the live site')
        self.assertNotIn('_worker.js', want, 'the Worker script is not a published asset')

    def test_a_binary_is_compared_by_bytes(self):
        src = (ROOT / 'tools/auditcheck.py').read_text(encoding='utf-8')
        self.assertIn('is not the file in the repository', src)


class TheNotesAreOneIndexedSet(unittest.TestCase):
    """CLAUDE.md was 280k against a 150k limit, so half of it was not read and nobody could say which
    half - the failure this repository is built to prevent, happening to the file that describes the
    preventing. It was split, not cut. What holds the split together is the index, and what makes the
    index trustworthy is that a file cannot be added or dropped without it being reported: a
    reference to a file that is not there is a dead end, and a file nobody references is a file that
    quietly stops being true, which is the more expensive of the two.
    """

    def setUp(self):
        sys.path.insert(0, str(ROOT / 'tools'))
        import notescheck
        self.notescheck = notescheck
        self.main = (ROOT / 'CLAUDE.md').read_text(encoding='utf-8')
        self.docs = sorted((ROOT / 'docs').glob('*.md'))

    def test_it_is_under_the_limit_with_room(self):
        # This asserted `< 150_000` - the limit itself - under this very name, so it would have gone
        # red at the moment content had already been dropped, which is no warning at all. The file it
        # guards did not stop at the limit either: it reached 280,013, nearly double, because nothing
        # measured. The budget is where we stop; the limit is where the harness does.
        n = len(self.main)
        self.assertLess(n, self.notescheck.BUDGET,
                        f'CLAUDE.md is {n:,} characters against a budget of '
                        f'{self.notescheck.BUDGET:,} - lift a topic into docs/ and index it')

    def test_the_budget_leaves_room_to_act_in(self):
        # A red run is fixed by moving a topic out, which takes judgement and an hour. Raising the
        # budget instead would be the one-line fix, and it would put this check back where it was.
        self.assertLessEqual(self.notescheck.BUDGET, self.notescheck.LIMIT * 3 // 4,
                             'the budget has crept up towards the limit, so there is no longer room '
                             'to split the file calmly when it fires')

    def test_the_number_is_printed_whether_or_not_it_is_breached(self):
        # A threshold that speaks only when breached says nothing about the direction of travel, and
        # this file grows by about a thousand characters every time it is touched.
        run = (ROOT / 'tests' / 'run.sh').read_text(encoding='utf-8')
        self.assertIn('notescheck.py', run, 'the size is measured by nothing that runs on its own')
        out = subprocess.run([sys.executable, str(ROOT / 'tools' / 'notescheck.py')],
                             capture_output=True, text=True, cwd=ROOT)
        self.assertIn('to spare', out.stdout, 'a passing run does not say how much room is left')

    def test_every_file_is_named_by_the_index(self):
        for f in self.docs:
            self.assertIn(f'docs/{f.name}', self.main,
                          f'docs/{f.name} exists and nothing points at it - it will go stale unread')

    def test_the_index_points_at_files_that_exist(self):
        for name in re.findall(r'\(docs/([\w.-]+\.md)\)', self.main):
            self.assertTrue((ROOT / 'docs' / name).is_file(), f'CLAUDE.md points at docs/{name}, which is not there')

    def test_each_entry_says_when_to_open_it(self):
        # A list of titles is a table of contents; what makes this an index is the second column,
        # which says what you must be about to do for the file to be worth opening.
        rows = re.findall(r'^\| \[`docs/[\w.-]+\.md`\]\(docs/[\w.-]+\.md\) \| (.+?) \|$',
                          self.main, re.M)
        self.assertEqual(len(rows), len(self.docs),
                         'the index and docs/ disagree about how many notes there are')
        for why in rows:
            self.assertGreater(len(why), 40, f'"{why}" does not say when to open the file')


class TheExtensionsReachTheMachineThatLoadsThem(unittest.TestCase):
    """The repository is on one machine and the browser that loads the extensions is on another, so
    `apps/<app>/` is mirrored into a synced folder. That copy depended on somebody remembering to ask
    for it - a rule living only as prose, which is the kind this repository has established gets
    broken - so `tests/run.sh` does it, first thing, on every run.

    First and not last, because a red suite is exactly when you want to look at the thing in a
    browser and `set -e` would never reach the end of the file.
    """

    def test_the_suite_mirrors_before_it_tests(self):
        run = (ROOT / 'tests' / 'run.sh').read_text(encoding='utf-8')
        self.assertIn('tools/totest.sh --auto', run, 'nothing copies the apps where they are loaded')
        self.assertLess(run.index('totest.sh'), run.index('unit: node'),
                        'the copy is after the tests, so a red run never reaches it')

    def test_it_does_not_ask_for_what_the_destination_refuses(self):
        """`-rlt` asked Google Drive to set file times, which it refuses, so rsync failed on every
        file and the silent fallback ran every time: `rm -rf` both extensions, then copy them back.
        Once this became automatic - once per battery run - that was two dozen delete-and-recreate
        cycles a day on a synced folder, and inside each one the folder is genuinely empty. The author
        found crm missing on the other machine, which is how a silent failure gets reported.
        """
        # Comments are stripped first. This file explains the flags at length in prose, so an
        # assertion over the whole text finds `--checksum` in a paragraph about `--checksum` and
        # passes over a call that no longer uses it - the same "read the code, not the prose" the
        # duplicate-message check already had to learn.
        code = '\n'.join(l for l in (ROOT / 'tools' / 'totest.sh').read_text(encoding='utf-8')
                         .splitlines() if not l.lstrip().startswith('#'))
        # The short-flag cluster only. A looser pattern over the line matched `--delete`, which has a
        # t in it: a check that fires on the wrong thing gets loosened until it fires on nothing.
        # The cluster is where it is defined, which is no longer always on the `rsync` line: two calls
        # share one RSYNC_FLAGS. A test that reads only the call site would go quiet the day the flags
        # move, which is the failure mode of asserting on a shape rather than on a value.
        m = re.search(r'(?:rsync|RSYNC_FLAGS=")\s*-([a-zA-Z]+)\s', code)
        self.assertIsNotNone(m, 'no rsync flags found')
        self.assertNotIn('t', m.group(1), f'-{m.group(1)} asks for times, which the destination refuses')
        self.assertNotIn('-a ', code, '-a implies times as well')
        self.assertIn('--no-times', code)
        self.assertIn('--checksum', code, 'without times there is no shortcut left but content')

    def test_force_replaces_the_comparison_rather_than_adding_to_it(self):
        """Writing only what changed has a tail: a write the sync client on the other side missed is
        never made again, because there is nothing left to write. `--force` regenerates the events
        without deleting anything - but `--ignore-times` *alongside* `--checksum` still skips a file
        whose content matches, which is every file in the case this exists for. It has to replace the
        comparison, and the first version added to it and reported "nothing, already in step".
        """
        code = '\n'.join(l for l in (ROOT / 'tools' / 'totest.sh').read_text(encoding='utf-8')
                         .splitlines() if not l.lstrip().startswith('#'))
        self.assertIn("COMPARE='--checksum'", code)
        self.assertIn("COMPARE='--ignore-times'", code)
        self.assertNotRegex(code, r'--checksum[^\n]*--ignore-times|--ignore-times[^\n]*--checksum',
                            'both comparisons on one call: the stricter one wins and force does nothing')

    def test_force_actually_rewrites(self):
        if not shutil.which('rsync'):
            self.skipTest('no rsync here - what this asserts about is rsync writing only what changed')
        with tempfile.TemporaryDirectory() as tmp:
            env = {**os.environ, 'ZOOST_TEST_DIR': str(Path(tmp) / 'zoost-test')}
            run = lambda *a: subprocess.run(['bash', str(ROOT / 'tools' / 'totest.sh'), *a],
                                            cwd=ROOT, capture_output=True, text=True, env=env)
            run()
            self.assertIn('nothing, already in step', run().stdout)
            forced = run('--force')
            self.assertRegex(forced.stdout, r'wrote: \d+ file', f'--force wrote nothing: {forced.stdout}')

    def test_without_rsync_it_copies_everything_and_says_so(self):
        """The two cases above are about rsync writing only what changed, so on a machine without
        rsync they were asserting the wrong thing and going red for it - reported from a container
        that has no rsync, where the suite read as «the sync tool is broken» rather than «this
        machine copies the other way». They skip now, and the other way is asserted here instead:
        the tool still mirrors both extensions, loudly, because that path deletes before it copies.
        """
        with tempfile.TemporaryDirectory() as tmp:
            fake = Path(tmp) / 'bin'
            fake.mkdir()
            # A stub rather than a stripped PATH: the script needs git, grep and the rest, and
            # removing those measures the sandbox instead of the tool - which is how the first
            # version of this experiment produced twenty misleading errors.
            (fake / 'rsync').write_text('#!/bin/sh\nexit 1\n', encoding='utf-8')
            (fake / 'rsync').chmod(0o755)
            dest = Path(tmp) / 'mirror'
            out = subprocess.run(['bash', str(ROOT / 'tools' / 'totest.sh')], capture_output=True,
                                 text=True, cwd=ROOT,
                                 env={**os.environ, 'PATH': f"{fake}:{os.environ['PATH']}",
                                      'ZOOST_TEST_DIR': str(dest)})
            self.assertEqual(out.returncode, 0, out.stderr)
            self.assertIn('falling back to delete-and-copy', out.stderr,
                          'it deleted and recopied both extensions without a word')
            self.assertIn('wrote: everything', out.stdout)
            for app in ('crm', 'analytics'):
                self.assertTrue((dest / app / 'manifest.json').is_file(),
                                f'{app} did not reach the mirror without rsync')
            # And the images, which the first version of the fallback left to an rsync that was never
            # going to run: they would have gone missing without a word on exactly the destination
            # this path exists for.
            if (ROOT / 'dist' / 'store').is_dir():
                self.assertTrue(sorted((dest / 'store').glob('*/*.png')),
                                'the images to upload did not reach the mirror without rsync')

    def test_the_destructive_fallback_says_so(self):
        # It deletes. Whoever is watching that folder should be told why it emptied, rather than
        # discovering it.
        sh = (ROOT / 'tools' / 'totest.sh').read_text(encoding='utf-8')
        i = sh.index('rm -rf "$DEST/crm"')
        self.assertIn('echo', sh[max(0, i - 300):i], 'the fallback deletes without a word')

    def test_an_unchanged_run_writes_nothing(self):
        # The number is the guard: "nothing to do" is what an unchanged run should say, and every
        # file, every time, is the shape of the defect coming back.
        if not shutil.which('rsync'):
            self.skipTest('no rsync here - what this asserts about is rsync writing only what changed')
        with tempfile.TemporaryDirectory() as tmp:
            env = {**os.environ, 'ZOOST_TEST_DIR': str(Path(tmp) / 'zoost-test')}
            first = subprocess.run(['bash', str(ROOT / 'tools' / 'totest.sh')], cwd=ROOT,
                                   capture_output=True, text=True, env=env)
            self.assertEqual(first.returncode, 0, first.stderr)
            second = subprocess.run(['bash', str(ROOT / 'tools' / 'totest.sh')], cwd=ROOT,
                                    capture_output=True, text=True, env=env)
            self.assertIn('nothing, already in step', second.stdout,
                          f'a second run rewrote the destination: {second.stdout}')

    def test_it_cannot_fail_the_battery(self):
        # A cloud drive that is offline is not a defect in this repository.
        out = subprocess.run(['bash', str(ROOT / 'tools' / 'totest.sh'), '--auto'],
                             capture_output=True, text=True, cwd=ROOT,
                             env={**os.environ, 'ZOOST_TEST_DIR': '/nonexistent/place/zoost-test'})
        self.assertEqual(out.returncode, 0, f'--auto failed where the folder is absent: {out.stderr}')
        self.assertEqual(out.stdout.strip(), '', 'it wrote a path it never copied to')

    def test_a_configured_folder_that_is_gone_is_said_even_in_auto(self):
        # The two silences are not the same silence. No destination at all is a machine that never
        # asked for a mirror; a destination that has gone missing is a mirror that has quietly stopped
        # being written, and the extension on the other machine then stays at whatever version it last
        # received. That was the state here for an afternoon, while the battery printed "not mirrored"
        # and no reason - the mount lived in another mount namespace and nothing said so.
        gone = subprocess.run(['bash', str(ROOT / 'tools' / 'totest.sh'), '--auto'],
                              capture_output=True, text=True, cwd=ROOT,
                              env={**os.environ, 'ZOOST_TEST_DIR': '/nonexistent/place/zoost-test'})
        self.assertEqual(gone.returncode, 0, 'a missing folder failed the battery')
        self.assertIn('/nonexistent/place is not mounted', gone.stderr,
                      f'--auto says nothing about a destination that has gone: {gone.stderr!r}')
        # ...and where nothing was ever configured it stays quiet, which is the other half
        env = {k: v for k, v in os.environ.items() if k != 'ZOOST_TEST_DIR'}
        with tempfile.TemporaryDirectory() as tmp:
            shutil.copytree(ROOT / 'tools', pathlib.Path(tmp) / 'tools',
                            ignore=shutil.ignore_patterns('machine.env'))
            shutil.copytree(ROOT / 'apps', pathlib.Path(tmp) / 'apps')
            quiet = subprocess.run(['bash', str(pathlib.Path(tmp) / 'tools' / 'totest.sh'), '--auto'],
                                   capture_output=True, text=True, cwd=tmp, env=env)
        self.assertEqual((quiet.returncode, quiet.stdout.strip(), quiet.stderr.strip()), (0, '', ''),
                         'it spoke about a mirror nobody asked for')

    def test_asked_directly_it_says_it_did_nothing(self):
        # A copy that reports success over a folder it never wrote to is the failure this repository
        # keeps naming; --auto is silence by request, not silence as a habit.
        out = subprocess.run(['bash', str(ROOT / 'tools' / 'totest.sh')],
                             capture_output=True, text=True, cwd=ROOT,
                             env={**os.environ, 'ZOOST_TEST_DIR': '/nonexistent/place/zoost-test'})
        self.assertEqual(out.returncode, 1)
        self.assertIn('is not mounted', out.stderr)
        self.assertIn('ZOOST_TEST_DIR', out.stderr)

    def test_a_mount_point_with_nothing_behind_it_is_not_a_folder(self):
        # The state that actually happened, and that the check above cannot see. With
        # `x-systemd.automount` the mount point answers stat() whether or not the mount works: the
        # kernel triggers it on first access, and with the host's sync client down the device is
        # absent, leaving an empty directory that passes every test a shell can make. `-d` said yes,
        # the first write failed, and the battery printed a raw mkdir error at the top of its output
        # while the extension on the other machine stayed at yesterday's build for a morning.
        #
        # It used to stand `/proc` in for that state - a directory that exists and refuses a mkdir -
        # and that is a property of Linux, not of the tool: on macOS there is no /proc at all, so the
        # script correctly said «is not mounted» and the assertion, which was waiting for the other
        # sentence, failed on somebody else's laptop. Reported from macOS. A directory this test makes
        # and takes the write bit off is the same shape, on any machine.
        with tempfile.TemporaryDirectory() as tmp:
            hold = pathlib.Path(tmp) / 'mountpoint'
            hold.mkdir()
            hold.chmod(0o500)                       # there, and refusing to be written in
            dest = str(hold / 'zoost-test')
            try:
                if os.access(hold, os.W_OK):        # root, or a filesystem that ignores the mode
                    self.skipTest('this user can write into a directory with no write bit - '
                                  'the state being tested cannot be built here')
                auto = subprocess.run(['bash', str(ROOT / 'tools' / 'totest.sh'), '--auto'],
                                      capture_output=True, text=True, cwd=ROOT,
                                      env={**os.environ, 'ZOOST_TEST_DIR': dest})
                self.assertEqual(auto.returncode, 0, 'a mount that is not there failed the battery')
                self.assertEqual(auto.stdout.strip(), '', 'it wrote a path it never copied to')
                self.assertIn('nothing usable is mounted on it', auto.stderr,
                              f'--auto blamed the script instead of the mount: {auto.stderr!r}')
                asked = subprocess.run(['bash', str(ROOT / 'tools' / 'totest.sh')],
                                       capture_output=True, text=True, cwd=ROOT,
                                       env={**os.environ, 'ZOOST_TEST_DIR': dest})
                self.assertEqual(asked.returncode, 1)
                self.assertIn('Nothing was copied', asked.stderr)
            finally:
                hold.chmod(0o700)                   # or the temporary directory cannot be removed

    def test_the_images_to_upload_travel_with_the_extensions(self):
        """The screenshots that go on the two listings are rendered here and uploaded from a machine
        with a browser and a dashboard open, so they have the same problem the extensions have: the
        machine that makes them is not the machine that needs them. They ride the same mirror, under
        `store/`, and they are copied only when they exist - a run that rendered none must leave the
        last rendered set alone, because that is the set the listing carries and an empty folder would
        say "nothing to upload" about a listing that has images on it.
        """
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / 'mirror'
            env = {**os.environ, 'ZOOST_TEST_DIR': str(dest)}
            out = subprocess.run(['bash', str(ROOT / 'tools' / 'totest.sh')], capture_output=True,
                                 text=True, cwd=ROOT, env=env)
            self.assertEqual(out.returncode, 0, out.stderr)
            rendered = sorted((ROOT / 'dist' / 'store').glob('*/*.png')) if (ROOT / 'dist' / 'store').is_dir() else []
            if rendered:
                self.assertEqual(sorted(p.name for p in (dest / 'store').glob('*/*.png')),
                                 sorted(p.name for p in rendered),
                                 'the images to upload did not travel with the extensions')
                self.assertIn('the set to upload', out.stdout, 'it copied them without saying so')
            else:
                self.assertFalse((dest / 'store').exists(),
                                 'it made an empty folder that reads as "nothing to upload"')
                self.assertIn('nothing rendered yet', out.stdout,
                              'asked directly, it said nothing about the images at all')

    def test_the_probe_is_a_write_and_it_takes_itself_away(self):
        """`mkdir -p "$DEST/apps"` was a write only by accident - the layer under the destination did
        not exist yet, so creating it wrote. With the two extensions at the top of that folder there
        is no such layer, and `mkdir -p` on a path that is already there succeeds without touching
        anything: it would have answered "yes" for a share gone read-only and for the empty directory
        an automount leaves behind, which is the exact state this check exists for.

        Both halves are proven, because a gate that always refuses looks identical to a strict one:
        it refuses a directory that exists and cannot be written, and it allows one that can - and in
        the allowing case it leaves nothing of its own behind.
        """
        sh = (ROOT / 'tools' / 'totest.sh').read_text(encoding='utf-8')
        self.assertIn(': > "$DEST/.zoost-writable"', sh, 'the probe writes nothing again')
        self.assertIn('rm -f "$DEST/.zoost-writable"', sh, 'the probe leaves its file behind')
        # And it asks only when something has already failed. The far side of that folder is watched
        # by a sync client, so a probe on the happy path is two events per battery run - a file
        # created and deleted, forwarded to another machine - about a question the copy itself answers.
        self.assertLess(sh.index('COPIED=$(rsync'), sh.index('if ! probe_writable'),
                        'the probe runs before the copy, so every good run writes for nothing')

        # refuses: a directory that is there and will not be written in - made here rather than
        # borrowed from the host, so the case exists on every machine and not only on Linux.
        with tempfile.TemporaryDirectory() as tmp:
            hold = pathlib.Path(tmp) / 'mountpoint'
            hold.mkdir()
            hold.chmod(0o500)
            try:
                if not os.access(hold, os.W_OK):
                    red = subprocess.run(['bash', str(ROOT / 'tools' / 'totest.sh')], capture_output=True,
                                         text=True, cwd=ROOT,
                                         env={**os.environ, 'ZOOST_TEST_DIR': str(hold / 'zoost-test')})
                    self.assertEqual(red.returncode, 1, 'a destination that cannot be written was accepted')
            finally:
                hold.chmod(0o700)

        # allows, and the folder afterwards holds the two extensions and nothing else
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / 'mirror'
            green = subprocess.run(['bash', str(ROOT / 'tools' / 'totest.sh')], capture_output=True,
                                   text=True, cwd=ROOT,
                                   env={**os.environ, 'ZOOST_TEST_DIR': str(dest)})
            self.assertEqual(green.returncode, 0, f'a writable destination was refused: {green.stderr}')
            left = sorted(p.name for p in dest.iterdir())
            self.assertNotIn('.zoost-writable', left, 'the probe left its file in the mirror')
            # The two extensions, the Store images, and one plain-text plan per product - what a
            # person has to exercise there for this release, derived on every sync. Nothing else, and
            # deliberately **not** tools/: a copy of handcheck.py over there would have no tags and no
            # apps/, so it would answer «nothing to run» and make an uncertified release look signed.
            self.assertLessEqual(set(left), {'crm', 'analytics', 'store',
                                             'what-to-test-crm.txt', 'what-to-test-analytics.txt'},
                                 f'the mirror holds something nobody asked for: {left}')
            self.assertIn('crm', left, 'the mirror is missing an extension')

    def test_delete_cannot_reach_past_what_it_is_replacing(self):
        """The destination used to have an `apps/` layer of its own, and now the two extensions sit at
        the top of a folder that also holds the Store images - and, on a network share, whatever else
        someone puts beside them. So the question «how far does `--delete` reach» stopped being
        academic. The answer is that it reaches inside the directories being transferred and no
        further: a bystander file survives, a file gone from an app is gone from its copy.

        That is rsync's guarantee rather than ours, which is exactly why it is asserted here. The
        comment in `totest.sh` first said the opposite - that a single call would wipe the folder -
        and this test was written to prove it before the claim was measured and found false. Holding
        a borrowed guarantee is the point: it is the one that would be expensive to discover.
        """
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / 'mirror'
            dest.mkdir()
            bystander = dest / 'notes.txt'
            bystander.write_text('not ours', encoding='utf-8')
            (dest / 'crm').mkdir()
            stale = dest / 'crm' / 'gone-from-the-source.js'
            stale.write_text('//', encoding='utf-8')
            out = subprocess.run(['bash', str(ROOT / 'tools' / 'totest.sh')], capture_output=True,
                                 text=True, cwd=ROOT,
                                 env={**os.environ, 'ZOOST_TEST_DIR': str(dest)})
            self.assertEqual(out.returncode, 0, out.stderr)
            self.assertTrue(bystander.exists(), 'the mirror deleted a file that was never ours')
            self.assertFalse(stale.exists(), 'a file gone from the source survived inside the mirror')

    def tracked(self):
        out = subprocess.run(['git', '-C', str(ROOT), 'ls-files'], capture_output=True, text=True)
        for rel in out.stdout.splitlines():
            f = ROOT / rel
            if f.suffix in ('.png', '.webp', '.ico', '.zip') or not f.is_file():
                continue
            try:
                yield rel, f.read_text(encoding='utf-8')
            except UnicodeDecodeError:
                continue

    def test_one_file_is_readable_from_both_sides(self):
        # It was sourced by shell and invisible to Python, so CHROME had to be exported into every
        # session and a port was written into two files. One file for these values was the point.
        sys.path.insert(0, str(ROOT / 'tools'))
        import machine
        self.assertEqual(machine.values(), machine.values(), 'values() is not stable')
        self.assertIn('tools/totest.sh', str(
            [rel for rel, t in self.tracked() if 'machine.env' in t]),
            'the shell side no longer reads the one file')
        # Run it rather than grep for it: the first version asserted the word "machine" appeared in
        # shots.py, which it does in a comment, so deleting the import left the check green over a
        # module that would raise on import.
        import shots
        if not shots.have_chrome():
            self.skipTest('no Chrome on this machine - the browser is what this asserts about')
        self.assertTrue(shots.chrome(), 'shots.py resolves no browser')
        # icons-receive.py serves on import, so it is read rather than run - but read for the call,
        # not for a word that occurs in prose.
        src = (ROOT / 'tools' / 'icons-receive.py').read_text(encoding='utf-8')
        self.assertIn("machine.get('ZOOST_ICONS_PORT'", src, 'the port is not configurable')
        self.assertIn('HTTPServer((\'127.0.0.1\', PORT)', src, 'the server still binds a fixed port')

    def test_the_environment_beats_the_file_on_both_sides(self):
        # A value passed on purpose - by a test, a one-off run, CI - must not be replaced by whatever
        # this machine usually does. The shell side got this backwards first.
        sys.path.insert(0, str(ROOT / 'tools'))
        import machine
        key = 'ZOOST_TEST_DIR'
        if key not in machine.values():
            self.skipTest('nothing configured on this machine to override')
        keep = os.environ.get(key)
        try:
            os.environ[key] = '/tmp/from-the-environment'
            self.assertEqual(machine.get(key), '/tmp/from-the-environment')
            os.environ.pop(key)
            self.assertEqual(machine.get(key), machine.values()[key])
        finally:
            os.environ.pop(key, None)
            if keep is not None:
                os.environ[key] = keep
        sh = (ROOT / 'tools' / 'totest.sh').read_text(encoding='utf-8')
        self.assertIn('ENV_DEST', sh, 'the shell side is back to letting the file win')

    def test_every_key_the_tools_read_is_in_the_example(self):
        # The values belong to a machine; **which keys exist does not**, and that half was being lost
        # with the untracked file. A new machine had nothing to read: the schema lived in comments
        # inside three separate tools. Derived from the code, so a key added tomorrow cannot be
        # invisible - that is the difference between an example file and a list somebody maintains.
        used = set()
        for f in sorted((ROOT / 'tools').glob('*')):
            if f.name in ('machine.py', 'machine.env', 'machine.env.example') or not f.is_file():
                continue
            try:
                text = f.read_text(encoding='utf-8')
            except (UnicodeDecodeError, IsADirectoryError):
                continue
            used |= set(re.findall(r"machine\.get\(['\"]([A-Z][A-Z0-9_]*)['\"]", text))
            used |= set(re.findall(r"\$\{([A-Z][A-Z0-9_]*):-", text))
        self.assertTrue(used, 'no key found in any tool - the pattern has stopped matching')
        example = (ROOT / 'tools' / 'machine.env.example').read_text(encoding='utf-8')
        declared = set(re.findall(r'^([A-Z][A-Z0-9_]*)=', example, re.M))
        missing = sorted(used - declared)
        self.assertEqual(missing, [],
                         f'{missing} read by a tool and absent from tools/machine.env.example, so a '
                         f'new machine has no way to know it exists')

    def test_the_example_is_tracked_and_the_real_one_is_not(self):
        tracked = subprocess.run(['git', '-C', str(ROOT), 'ls-files', 'tools/machine.env',
                                  'tools/machine.env.example'], capture_output=True, text=True)
        listed = tracked.stdout.split()
        self.assertIn('tools/machine.env.example', listed, 'the schema is not in the repository')
        self.assertNotIn('tools/machine.env', listed,
                         'this machine\'s own values are about to be pushed')

    def test_the_loader_never_prints_a_value(self):
        # It runs in a terminal somebody may be sharing, and the names are what you need to see.
        src = (ROOT / 'tools' / 'machine.py').read_text(encoding='utf-8')
        main = src[src.index("__name__ == '__main__'"):]
        self.assertNotIn('found[k]', main)
        self.assertNotIn('values()[k]', main)

    def test_no_machine_value_has_leaked_into_a_tracked_file(self):
        # Derived from the config itself: whatever this machine has configured must appear in no file
        # anyone else will check out. Silent where there is no config, because then there is nothing
        # to compare - the pattern case below is what covers that.
        env = ROOT / 'tools' / 'machine.env'
        if not env.exists():
            self.skipTest('no tools/machine.env on this machine')
        values = [v.strip().strip('\'"') for line in env.read_text(encoding='utf-8').splitlines()
                  if '=' in line and not line.lstrip().startswith('#')
                  for v in [line.split('=', 1)[1]] if v.strip().strip('\'"')]
        self.assertTrue(values, 'tools/machine.env holds nothing')
        for rel, text in self.tracked():
            for v in values:
                self.assertNotIn(v, text, f'{rel} carries a value that belongs to one machine')

    def test_no_tracked_file_names_a_machine_shaped_path(self):
        # The first version of this checked tools/ and tests/run.sh, and the same commit put the path
        # in CLAUDE.md - under a test asserting it was written in one place. A hand-picked file list
        # is not a check, it is a list. This one reads the tree from git and has no allow-list, so
        # prose that needs to talk about such a path uses a placeholder, as CLAUDE.md now does.
        # The drive-letter half needs the lookbehind: without it `SQL:\n` in the Analytics panel
        # matched, and a check with false positives is one that gets switched off. A drive is a
        # *single* letter, so anything with a letter in front of it is a word ending in a colon.
        pattern = re.compile(r'/mnt/[a-z]/|/Users/[A-Za-z]|/home/[a-z]|(?<![A-Za-z])[A-Z]:\\')
        allowed = {'tools/machine.env'}          # untracked anyway; belt and braces
        for rel, text in self.tracked():
            if rel in allowed:
                continue
            m = pattern.search(text)
            self.assertIsNone(m, f'{rel} names {m.group(0) if m else ""!r} - a path that is a '
                                 f'property of one machine. Put it in tools/machine.env and write a '
                                 f'placeholder here')


class TheGateOnTheTagCanBePassed(unittest.TestCase):
    """`tools/release.sh` ran `auditcheck --offline`, which reports the skipped live comparison as a
    finding on purpose - so the gate could never pass, over a line nobody can act on.

    It refused every run from the hour it landed, an hour after the last tag, until somebody tried to
    cut a release. Nothing was wrong on screen, because nobody ran it: a gate is exercised once per
    release and this repository had not had one since. Proving a check can *fail* is half of it, and
    this file says so in several places; the other half is proving it can *pass*, and that half was
    missing everywhere it is written down.

    Two things are structurally true at tag time and are notes rather than refusals there: the bump
    commit is not pushed yet (the routine pushes the commit and the tag together, after this), and
    the site cannot serve a release that does not exist. A dirty tree is not one of them.
    """

    def setUp(self):
        sys.path.insert(0, str(ROOT / 'tools'))
        import auditcheck
        self.auditcheck = auditcheck

    def repo(self, tmp):
        """A real repository, one commit ahead of its upstream, so the state is not simulated."""
        d, bare = Path(tmp) / 'work', Path(tmp) / 'origin.git'
        d.mkdir()
        run = lambda *a: subprocess.run(['git', '-C', str(d), *a], capture_output=True, check=True)
        subprocess.run(['git', 'init', '--bare', '-q', str(bare)], check=True, capture_output=True)
        subprocess.run(['git', 'init', '-q', '-b', 'main', str(d)], check=True, capture_output=True)
        run('config', 'user.email', 'x@example.com'); run('config', 'user.name', 'x')
        (d / 'a.txt').write_text('one\n')
        run('add', '-A'); run('commit', '-qm', 'one')
        run('remote', 'add', 'origin', str(bare))
        run('push', '-q', '-u', 'origin', 'main')
        (d / 'a.txt').write_text('two\n')                 # the bump commit, committed and unpushed
        run('add', '-A'); run('commit', '-qm', 'two')
        return d

    def state(self, root, **kw):
        findings, notes = [], []
        keep = self.auditcheck.ROOT
        try:
            self.auditcheck.ROOT = root
            self.auditcheck.deploy_state(findings, notes, **kw)
        finally:
            self.auditcheck.ROOT = keep
        return findings, notes

    def test_at_tag_time_what_cannot_be_acted_on_is_a_note(self):
        with tempfile.TemporaryDirectory() as tmp:
            findings, notes = self.state(self.repo(tmp), offline=True, before_tag=True)
        self.assertEqual(findings, [], f'the gate refuses over something nobody can fix: {findings}')
        said = ' '.join(notes)
        self.assertIn('not pushed', said, 'the gate stopped saying the commit is unpushed at all')
        self.assertIn('live site was not looked at', said, 'the gate no longer says what it skipped')

    def test_interactively_the_same_two_still_refuse(self):
        # The reason they exist: four commits sat unpushed while the fix in them was reported as
        # done. --offline must keep its teeth, or that comes back.
        with tempfile.TemporaryDirectory() as tmp:
            findings, _ = self.state(self.repo(tmp), offline=True, before_tag=False)
        self.assertEqual(len(findings), 2, f'--offline has stopped refusing: {findings}')

    def test_a_dirty_tree_is_a_finding_in_both(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = self.repo(tmp)
            (d / 'a.txt').write_text('three\n')
            findings, _ = self.state(d, offline=True, before_tag=True)
        self.assertTrue(any('not committed' in f for f in findings),
                        'the gate would tag a tree nobody else can see')

    def test_a_clean_run_says_what_it_actually_looked_at(self):
        # --before-tag can end in «0 findings», which --offline never could, so it inherited a
        # sentence opening «What is served is what is in the repository» from a run that fetched
        # nothing. A summary is a claim like any other.
        src = (ROOT / 'tools' / 'auditcheck.py').read_text(encoding='utf-8')
        tail = src[src.index("print(f'{len(findings)} finding(s)"):]
        i, j = tail.index('0 findings.'), tail.index('What is served')
        self.assertLess(i, j, 'the clean line asserts the live comparison unconditionally')
        self.assertIn('live site was not looked at', tail[i:j],
                      'a run that skipped the site can still claim the site matches')

    def test_release_runs_the_gate_that_can_pass(self):
        src = (ROOT / 'tools' / 'release.sh').read_text(encoding='utf-8')
        self.assertIn('auditcheck.py --before-tag', src)
        self.assertNotIn('auditcheck.py --offline', src,
                         'release.sh is back on the mode that refuses over the skip itself')


class TheDashboardIsReadRatherThanTrusted(unittest.TestCase):
    """`submitted.py` records what is in the repository when it runs and takes the click on trust.
    That is honest about what it can observe, and blind to the one thing that matters: whether the
    text on the item is the text we have. Google publishes no API for those fields, so the only way
    to find out is to paste the page.

    It found two on its first run. §4 and §5 had been corrected on 8 and 3 August and never pasted,
    so the Store was still serving «a local, read-only mirror» and «Zoost never writes back to Zoho»
    - the absolute this project walked back everywhere else - while `storecopy --changed` said there
    was nothing to paste.

    The fixtures are written from store-listing.md, never saved from the real page: that page carries
    a session token, an email address and the author's own portal.
    """

    def setUp(self):
        sys.path.insert(0, str(ROOT / 'tools'))
        import dashcheck, storecopy
        self.dashcheck, self.storecopy = dashcheck, storecopy
        self.mine = {str(n): b for n, _, _, b in storecopy.sections('crm')}

    def page(self, **override):
        """A dashboard page that agrees with the repository, unless told otherwise."""
        say = {k: override.get(k, self.mine[str(n)])
               for k, n in self.dashcheck.FIELD.items()}
        out = ['<html><body>']
        for k, body in say.items():
            attr = '' if k == 'single-purpose' else f' data-payload={k}'
            out.append(f'<textarea id="x" disabled{attr}>{html.escape(body)}</textarea>')
        out.append(f'<input type="text" value="{override.get("privacy", "https://zoost.it/privacy")}"'
                   f' maxlength="2048">')
        for v in range(1, 10):
            tick = ' checked' if v in override.get('collected', ()) else ''
            out.append(f'<input type="checkbox" value="{v}" disabled{tick} aria-label="Qualcosa">')
        for i in range(override.get('attested', 3)):
            out.append(f'<input type="checkbox" disabled checked aria-label="Attestation {i}">')
        remote = 'true' if override.get('remote') else 'false'
        out.append(f'<input type="radio" value="{remote}" disabled checked>')
        return '\n'.join(out) + '</body></html>'

    def run_it(self, page):
        with tempfile.TemporaryDirectory() as tmp:
            f = Path(tmp) / 'page.html'
            f.write_text(page, encoding='utf-8')
            r = subprocess.run([sys.executable, str(ROOT / 'tools' / 'dashcheck.py'), 'crm', str(f)],
                               cwd=ROOT, capture_output=True, text=True)
            return r.returncode, r.stdout

    def test_a_page_that_agrees_is_quiet(self):
        code, out = self.run_it(self.page())
        self.assertEqual(code, 0, out)
        self.assertIn('0 finding(s)', out)
        self.assertIn(f'{len(self.dashcheck.FIELD)} of {len(self.dashcheck.FIELD)} fields', out)

    def test_every_field_is_compared(self):
        # One at a time, so a field silently dropped from the map cannot hide behind another.
        for key, n in self.dashcheck.FIELD.items():
            code, out = self.run_it(self.page(**{key: 'something else entirely'}))
            self.assertEqual(code, 1, f'{key} drifted and nothing said so')
            self.assertIn(f'§{n}', out)

    def test_the_switches_are_read_too(self):
        for kw, expect in ((dict(collected=(1,)), 'declares data collection'),
                           (dict(attested=2), 'of the 3 data-use attestations'),
                           (dict(remote=True), 'remote code'),
                           (dict(privacy='https://example.com/privacy'), 'privacy policy URL')):
            code, out = self.run_it(self.page(**kw))
            self.assertEqual(code, 1, f'{kw} passed unnoticed')
            self.assertIn(expect, out)

    def test_a_markup_change_is_loud(self):
        """The anchors are named, so losing one is a finding rather than a wrong comparison."""
        code, out = self.run_it(self.page().replace('data-payload=storage', ''))
        self.assertEqual(code, 1)
        self.assertIn('the markup moved', out)

    def test_two_unlabelled_fields_are_not_guessed_between(self):
        page = self.page().replace('data-payload=tabs', '')
        code, out = self.run_it(page)
        self.assertEqual(code, 1)
        self.assertIn('not made', out)


class EveryIconDeclaredIsThereAndEveryIconThereIsDeclared(unittest.TestCase):
    """The manifests' icon keys against the files, in both directions.

    Nothing checked this. Four tests already hold the *marks* - the geometry of the SVG sources, the
    stroke weight, the caps, one hue each - and not one of them would have noticed a declared PNG
    that was not on disk, a PNG that was not the size its key claims, or a leftover raster shipping
    in the package. Chrome would have found the first at load and the Store at review, which is the
    expensive end of the chain to find it at.

    It is the rule this repository already states - declare only what you have, have everything you
    declare - applied to the one set of files where it was running on trust. The app list is derived
    from the tree rather than named, so a third product is covered without anybody remembering.
    """

    ROOT = pathlib.Path(__file__).resolve().parent.parent

    def manifests(self):
        found = sorted(self.ROOT.glob('apps/*/manifest.json'))
        self.assertTrue(found, 'no app manifests found - has the layout moved?')
        return [(m.parent.name, json.loads(m.read_text(encoding='utf-8'))) for m in found]

    def declared(self, man):
        """Every (size, path) the manifest asks Chrome to load, from both keys that name icons."""
        out = set()
        for block in (man.get('icons') or {}, (man.get('action') or {}).get('default_icon') or {}):
            for size, rel in block.items():
                out.add((int(size), rel))
        return out

    def test_every_declared_icon_exists_and_is_the_size_it_claims(self):
        for app, man in self.manifests():
            got = self.declared(man)
            self.assertTrue(got, f'{app}: the manifest declares no icons at all')
            for size, rel in sorted(got):
                with self.subTest(app=app, icon=rel):
                    f = self.ROOT / 'apps' / app / rel
                    self.assertTrue(f.exists(), f'{app}: {rel} is declared and not on disk')
                    b = f.read_bytes()
                    self.assertEqual(b[:8], b'\x89PNG\r\n\x1a\n', f'{app}: {rel} is not a PNG')
                    # Width and height out of the IHDR, which is always the first chunk. Read rather
                    # than trusted: a 32 copied over a 24 is invisible in a file listing and wrong in
                    # the toolbar, where nobody would think to look for a manifest fault.
                    w, h = struct.unpack('>II', b[16:24])
                    self.assertEqual((w, h), (size, size),
                                     f'{app}: {rel} is declared as {size} and is {w}x{h}')

    def test_no_raster_ships_that_nothing_declares(self):
        # The other direction, and the one that goes unnoticed: build.sh copies apps/<app>/ verbatim,
        # so a PNG left behind after a resize is shipped, listed in the public `unzip -l`, and read by
        # a reviewer as something the extension uses. The SVG is deliberately exempt - it is the
        # source the rasters are rendered from and it lives beside them on purpose, because the
        # separate `brand/` folder that used to hold the geometry drifted from the shipped mark.
        for app, man in self.manifests():
            declared = {rel for _, rel in self.declared(man)}
            for f in sorted((self.ROOT / 'apps' / app / 'icons').glob('*.png')):
                rel = f'icons/{f.name}'
                with self.subTest(app=app, icon=rel):
                    self.assertIn(rel, declared,
                                  f'{app}: {rel} ships and no manifest key names it')

    def test_the_renderer_knows_about_every_one_of_them(self):
        # tools/icons.html is where the PNGs come from. A size added to a manifest and not to it is a
        # file that exists once and is silently stale after the next regeneration - which is exactly
        # how apps/crm ended up with rasters whose source nobody had kept.
        jobs = (self.ROOT / 'tools' / 'icons.html').read_text(encoding='utf-8')
        for app, man in self.manifests():
            for size, rel in sorted(self.declared(man)):
                with self.subTest(app=app, icon=rel):
                    self.assertIn(f"{size}, 'apps/{app}/{rel}'", jobs,
                                  f'{app}: nothing renders {rel} - tools/icons.html has no job for it')


class APinnedActionHasSomethingThatOffersToMoveIt(unittest.TestCase):
    """Every Action is pinned to a hash, and something proposes the next one.

    Both halves are the decision; only one of them was ever written down. A hash makes the supply
    chain checkable and makes an upgrade deliberate - and with nothing offering the upgrade,
    deliberate turned into frozen: `actions/checkout` sat three majors behind and
    `actions/attest-build-provenance` four, surfacing only as a runner warning about a retiring Node.

    So this holds the pair. Pinning without `dependabot.yml` is the state that already cost months,
    and it looks identical to a well-maintained repository from the inside.
    """

    ROOT = pathlib.Path(__file__).resolve().parent.parent
    WORKFLOWS = ROOT / '.github' / 'workflows'

    def uses(self):
        return [(f.name, n, l.strip())
                for f in sorted(self.WORKFLOWS.glob('*.yml'))
                for n, l in enumerate(f.read_text(encoding='utf-8').splitlines(), 1)
                if 'uses:' in l]

    def test_every_action_is_pinned_to_a_hash_and_says_which_release(self):
        used = self.uses()
        self.assertTrue(used, 'no workflow uses an action - has the chain moved?')
        for name, n, line in used:
            with self.subTest(where=f'{name}:{n}'):
                # The comment is not decoration: it is the only thing that says what the hash *is*,
                # and Dependabot rewrites it alongside the hash. Without it a pin is unreadable and
                # an upgrade is unreviewable.
                self.assertRegex(line, r'uses:\s+[\w.-]+/[\w.-]+@[0-9a-f]{40}\s+# v\d+\.\d+\.\d+',
                                 f'{name} line {n} is not a hash pin with its version comment')

    def test_something_offers_the_next_hash(self):
        cfg = self.ROOT / '.github' / 'dependabot.yml'
        self.assertTrue(cfg.exists(),
                        'actions are pinned to hashes and nothing proposes newer ones - '
                        'that state cost three and four majors of drift once already')
        text = cfg.read_text(encoding='utf-8')
        self.assertIn('github-actions', text, 'dependabot.yml watches no ecosystem the repo has')
        # Anchored at the root, because that is where Dependabot looks for .github/workflows. Pointed
        # at the workflows directory it finds nothing and says nothing, which is this whole class of
        # defect wearing the fix's clothes.
        dirs = [v.split('#')[0].strip().strip('\'"')
                for v in re.findall(r'^\s*directory:(.*)$', text, re.M)]
        self.assertEqual(dirs, ['/'],
                         'the github-actions ecosystem must be anchored at the repository root, '
                         'which is where Dependabot looks for .github/workflows')


class EveryToolThatTalksToGoogleKnowsWhoWeAre(unittest.TestCase):
    """The publisher and the item ids resolve, without a network and without a key.

    This exists because they stopped resolving and nothing said so. `cws.publisher()` read
    `const PUBLISHER` out of `site/_worker.js`; the Worker then stopped calling the Chrome Web Store
    API and the constant left with the code that used it, which was right - dead code is not allowed
    to sit there waiting to be somebody's dependency. Every tool in `cws.py` broke in the same
    instant, `store upload` among them, and the failure surfaced forty minutes later in a scheduled
    workflow nobody was watching. A release would have found it at the worst moment.

    So this is the cheap half of "find every other user before touching a shared thing": the identity
    lookups are exercised on every run of the suite, on the machine where the edit is being made.
    They read files and parse text, so they cost nothing and need no credential.
    """

    def setUp(self):
        import importlib
        self.cws = importlib.import_module('cws')

    def test_the_publisher_resolves(self):
        # Shape rather than value: the id is not secret, but asserting it here would make this a
        # second copy of the fact, which is what the class is about.
        self.assertRegex(self.cws.publisher(), r'^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$')

    def test_both_items_resolve(self):
        for app in ('crm', 'analytics'):
            with self.subTest(app=app):
                self.assertRegex(self.cws.item_id(app), r'^[a-p]{32}$',
                                 f'{app}: no item id - has site/_worker.js dropped EXT_ID?')
        self.assertNotEqual(self.cws.item_id('crm'), self.cws.item_id('analytics'))

    def test_an_app_nobody_declared_stops_rather_than_guesses(self):
        with self.assertRaises(SystemExit):
            self.cws.item_id('nosuchapp')


class TheStoreReadingIsShapedBeforeItIsPublished(unittest.TestCase):
    """What Google says about our items, on its way into a file the site serves.

    These cases were `pickStatus` in site/_worker.js and moved with the job when the credential left
    the Worker. They are kept because what they protect did not move: the promise that a change at
    Google's end can cost us a number and must never invent one. The response below is recorded from
    a real fetchStatus, so the shape here cannot drift from the API's.
    """

    def setUp(self):
        import importlib
        self.s = importlib.import_module('storestatus')

    def test_the_status_is_read(self):
        d = {'publishedItemRevisionStatus': {
                 'state': 'PUBLISHED',
                 'distributionChannels': [{'deployPercentage': 100, 'crxVersion': '1.9.0'}]},
             'submittedItemRevisionStatus': {
                 'state': 'PENDING_REVIEW',
                 'distributionChannels': [{'deployPercentage': 100, 'crxVersion': '1.38.4'}]}}
        out = self.s.shape(d)
        self.assertEqual(out['published']['version'], '1.9.0')
        self.assertEqual(out['published']['state'], 'PUBLISHED')
        self.assertEqual(out['submitted']['version'], '1.38.4')
        self.assertEqual(out['submitted']['state'], 'PENDING_REVIEW')
        self.assertEqual(out['published']['deployPercentage'], 100)

    def test_a_rejection_is_a_state_not_an_absence(self):
        # The whole reason for leaving the scrape behind. A refused version looks exactly like a
        # queued one from outside, so without this the badge would claim «awaiting review» for ever.
        d = {'publishedItemRevisionStatus': {'state': 'PUBLISHED',
                 'distributionChannels': [{'crxVersion': '1.9.0'}]},
             'submittedItemRevisionStatus': {'state': 'REJECTED',
                 'distributionChannels': [{'crxVersion': '1.38.4'}]}}
        self.assertEqual(self.s.shape(d)['submitted']['state'], 'REJECTED')

    def test_nothing_submitted_is_null_not_an_empty_claim(self):
        d = {'publishedItemRevisionStatus': {'state': 'PUBLISHED',
                 'distributionChannels': [{'crxVersion': '1.9.0'}]}}
        self.assertIsNone(self.s.shape(d)['submitted'])

    def test_a_field_that_is_not_a_version_is_dropped(self):
        # Google can send anything; what it must never do is get a made-up number onto the page.
        for junk in ('', 'draft', '1.9.0-beta', 'v1.9.0', None):
            d = {'publishedItemRevisionStatus': {'state': 'PUBLISHED',
                     'distributionChannels': [{'crxVersion': junk}]}}
            self.assertIsNone(self.s.shape(d)['published']['version'], junk)

    def test_a_response_carrying_neither_revision_is_not_a_reading(self):
        self.assertIsNone(self.s.shape({}))
        self.assertIsNone(self.s.shape({'takenDown': True}))


class NothingShippedCanWriteToZoho(unittest.TestCase):
    """«No write path to Zoho» is the first non-negotiable in CLAUDE.md, and until now it was prose:
    a contributor - or a session here - could add a POST to a CRM endpoint and nothing but a reader's
    attention stood in the way. This repository has already written down what happens to a rule that
    lives only as prose. An outside audit asked for exactly this and it was the one finding with no
    counter-argument.

    The check reads every `fetch(` in the shipped code, takes the call whole, and decides by where it
    goes: the two AI hosts the manifests declare may use any method - they are POST by nature and the
    key travels in the body - and everything else, which is Zoho, must be a GET.

    The single exception is named rather than pattern-matched, because an exception that is a regular
    expression is a hole: `/ZDBCreateERD.ma?ZDBACTION=CREATEDATABASEERD` computes the ER model and
    returns the ER model - and what a server keeps afterwards is not observable from a browser, so the
    reason recorded here is about what Zoost sends. It is already the one absolute this project walks
    back in its own words -
    «Zoost never writes to Zoho» fell to an authenticated POST whose URL contains CREATE.
    """

    AI_HOSTS = ('api.anthropic.com', 'api.openai.com')

    # A file may hold one non-GET helper towards Zoho only if every endpoint it is ever handed is
    # named here. Keying the exception on the *call site* was the first version and it did not hold:
    # the fetch says `BASE + path`, so the URL is not there to check - and an allowlist that matches
    # the helper rather than its arguments would let a second endpoint through the same door for
    # ever. What is exceptional is the endpoint, so the endpoint is what is written down.
    ALLOWED_POST = {
        'analytics/content-bridge.js': {
            'helper': 'post',
            'endpoints': ('/ZDBCreateERD.ma?ZDBACTION=CREATEDATABASEERD',),
            'why': 'returns a workspace ER model, the same call the Analytics diagram screen makes - '
                   'named CREATE, which is the one absolute this project walks back in its own words',
        },
    }

    @staticmethod
    def _code(src: str) -> str:
        """The source with comments blanked, offsets preserved.

        `\\bfetch\\s*\\(` matches «re-fetch (backfill)» in a sentence, and once «I could not read the
        method» stopped meaning GET, that comment became a finding about a write path. A check about
        code reads code - the third time in one day this suite was fooled by its own prose.

        It is a state machine and not a set of rules, because three cheaper versions were each wrong
        in a different direction, all within the hour:

          - strings before comments blanked from the `//` inside 'https://api.anthropic.com/…' to the
            end of the line, cutting two POSTs in half and reporting them as writes towards Zoho;
          - comments before strings ran away over the quote inside /(?:crmZgid|["']?zgid["']?)…/,
            swallowing 10KB of `content-bridge.js` - a regex literal I had just written down as a
            limit that does not bite, in the first file it read;
          - consuming a backtick to the next backtick lost track inside `${ `nested` }`, which both
            panels use constantly, and left comments unblanked again.

        A limit asserted rather than measured is a blind spot with a note attached. So: one pass, one
        stack, and a check over every shipped script that each `//` line is blank in the output.
        """
        out, i, n = [], 0, len(src)
        stack = []            # '`' inside a template, '{' inside a ${…} of one
        prev = None           # last non-space code character, for regex-vs-division
        KEYWORD = re.compile(r'\b(return|typeof|case|in|of|new|delete|void|do|else)\s*$')

        def emit(text, blank=False):
            nonlocal prev
            out.append(''.join(' ' if c != '\n' else '\n' for c in text) if blank else text)
            if not blank:
                t = text.rstrip()
                if t:
                    prev = t[-1]

        while i < n:
            c = src[i]
            intpl = stack and stack[-1] == '`'      # inside template text: only ${ and ` matter
            if intpl:
                if c == '\\':
                    emit(src[i:i + 2]); i += 2; continue
                if c == '`':
                    stack.pop(); emit(c); i += 1; continue
                if src.startswith('${', i):
                    stack.append('{'); emit('${'); i += 2; continue
                emit(c); i += 1; continue
            if c == '}' and stack and stack[-1] == '{':
                stack.pop(); emit(c); i += 1; continue
            if src.startswith('/*', i):
                j = src.find('*/', i + 2); j = n if j < 0 else j + 2
                emit(src[i:j], blank=True); i = j; continue
            if src.startswith('//', i):
                j = src.find('\n', i); j = n if j < 0 else j
                emit(src[i:j], blank=True); i = j; continue
            if c == '`':
                stack.append('`'); emit(c); i += 1; continue
            if c in '\'"':
                j = i + 1
                while j < n and src[j] != c:
                    j += 2 if src[j] == '\\' else 1
                j = min(j + 1, n)
                emit(src[i:j]); i = j; continue
            if c == '/' and (prev is None or prev in '(,=:[!&|?{};+-*%~^<>'
                             or KEYWORD.search(''.join(out[-3:]))):
                j, cls = i + 1, False
                while j < n:
                    ch = src[j]
                    if ch == '\\':
                        j += 2; continue
                    if ch == '[':
                        cls = True
                    elif ch == ']':
                        cls = False
                    elif ch == '/' and not cls:
                        break
                    elif ch == '\n':
                        break               # not a regex after all; stop rather than run away
                    j += 1
                emit(src[i:min(j + 1, n)]); i = min(j + 1, n); continue
            emit(c); i += 1
        return ''.join(out)

    def calls(self, src: str):
        """Every fetch(...) with its argument text, taken by walking the brackets."""
        src = self._code(src)
        out = []
        for m in re.finditer(r'\bfetch\s*\(', src):
            depth, i = 0, m.end() - 1
            while i < len(src):
                if src[i] == '(':
                    depth += 1
                elif src[i] == ')':
                    depth -= 1
                    if depth == 0:
                        break
                i += 1
            out.append(src[m.end():i])
        return out

    @staticmethod
    def _opts_not_literal(call: str) -> bool:
        """True when the init argument is not an object literal written at the call.

        `fetch(url, OPT)` and `fetch(req)` say nothing about the method here, and the fourth of the
        four spellings that walked past this gate was exactly that. «I cannot read it» is not GET.
        """
        depth, cut = 0, None
        for k, ch in enumerate(call):
            if ch in '([{':
                depth += 1
            elif ch in ')]}':
                depth -= 1
            elif ch == ',' and depth == 0:
                cut = k
                break
        if cut is None:
            # One argument: a bare identifier is a Request object; anything else is a URL, so GET.
            return bool(re.fullmatch(r'\s*[A-Za-z_$][\w$]*\s*', call))
        return not call[cut + 1:].lstrip().startswith('{')

    def test_every_shipped_fetch_to_zoho_is_a_read(self):
        seen = 0
        for f in sorted((ROOT / 'apps').rglob('*.js')):
            rel = '/'.join(f.relative_to(ROOT / 'apps').parts)
            src = f.read_text(encoding='utf-8')
            for call in self.calls(src):
                seen += 1
                # Any quoting, and «I could not tell» is not GET.
                #
                # This read `method:\s*'([A-Z]+)'` and defaulted to GET, so four ordinary spellings
                # walked past the one gate that enforces «no write path to Zoho»: a double-quoted
                # "DELETE", a backticked `PUT`, `method: verb` with the verb in a variable, and an
                # options object built above the call. Measured by planting each. The URL half of
                # this check resolves constants for exactly that reason - «a URL moved into a
                # variable cannot hide» - and the method is the half that decides whether it is a
                # write. The adversary named in CLAUDE.md is a session here adding a write path by
                # accident, which is the adversary that would have got through.
                m = re.search(r'''method\s*:\s*['"`]([A-Za-z]+)['"`]''', call)
                if m:
                    method = m.group(1).upper()
                elif re.search(r'\bmethod\s*:', call):
                    method = 'UNKNOWN'      # named but not a literal: cannot be read as a read
                elif self._opts_not_literal(call):
                    method = 'UNKNOWN'      # a Request object, or an options object built elsewhere
                else:
                    method = 'GET'
                # The host is not always written at the call: the OpenAI one is `OPENAI_BASE +
                # '/chat/completions'`, and reading the call text alone said «a POST to Zoho» about
                # the AI provider. So single-quoted constants of the file are resolved first - the
                # indirection is one hop by convention here, and a check that cannot see through it
                # would be answered by moving a URL into a variable.
                # It is two hops, not one - `const base = OPENAI_BASE` and `const OPENAI_BASE =
                # 'https://api.openai.com/v1'` - so the widening runs until it stops growing rather
                # than once. A fixed number of rounds is the same guess one level up.
                defs = dict(re.findall(r'''const (\w+)\s*=\s*['"`]([^'"`]+)['"`]''', src))
                defs.update(dict(re.findall(r"const (\w+)\s*=\s*(\w+);", src)))
                widened, before = call, None
                while widened != before:
                    before = widened
                    for name, val in defs.items():
                        if re.search(r'\b' + name + r'\b', widened) and val not in widened:
                            widened += ' ' + val
                if method == 'GET' or any(h in widened for h in self.AI_HOSTS):
                    continue          # a read, or one of the two declared AI hosts, whose job is a POST
                self.assertIn(rel, self.ALLOWED_POST,
                              f'{rel}: a {method} towards Zoho - «no write path to Zoho» is the first '
                              f'non-negotiable. If it writes nothing, name its endpoints in '
                              f'ALLOWED_POST with the reason. Call: {call.strip()[:100]}')
        self.assertGreater(seen, 4, 'no fetch call was found at all, so this asserted nothing')



    def test_the_four_spellings_that_used_to_walk_past(self):
        """Each of these was planted against the previous version and reported GET.

        The URL half of this check resolves constants because «a URL moved into a variable cannot
        hide»; the same reasoning was never applied to the method, and the method is the half that
        decides whether it is a write. The adversary CLAUDE.md names - a session here adding a write
        path by accident - is the one that would have got through.
        """
        def method_of(call):
            m = re.search(r"""method\s*:\s*['"`]([A-Za-z]+)['"`]""", call)
            if m:
                return m.group(1).upper()
            if re.search(r'\bmethod\s*:', call):
                return 'UNKNOWN'
            return 'UNKNOWN' if NothingShippedCanWriteToZoho._opts_not_literal(call) else 'GET'

        t = NothingShippedCanWriteToZoho()
        cases = {
            "fetch(BASE + '/x' + id, { method: verb })": 'UNKNOWN',
            'fetch(BASE + "/x", { method: "DELETE" })': 'DELETE',
            'fetch(BASE + \'/x\', { method: `PUT` })': 'PUT',
            "fetch(BASE + '/x', OPT)": 'UNKNOWN',
            "fetch(req)": 'UNKNOWN',
            "fetch(BASE + '/x')": 'GET',
            "fetch(BASE + '/x', { headers: h })": 'GET',
        }
        for src, want in cases.items():
            got = [method_of(c) for c in t.calls(src)]
            self.assertEqual(got, [want], f'{src} read as {got}, expected {want}')

    def test_the_comment_blanker_reads_every_shipped_script(self):
        """The crude half of this check: every `//` line must be blank in the output, in every file.

        Three earlier versions each passed the suite and were wrong - a `//` in a URL, a quote in a
        regex literal, a nested `${ `template` }`. None of them was caught by a case; all three were
        caught by running the blanker over the whole tree and comparing, which is the mechanism this
        repository already uses for `htmlcheck` and `csscheck`: a second, cruder pass over the same
        subject, compared by position.
        """
        checked = 0
        for f in sorted((ROOT / 'apps').rglob('*.js')) + sorted((ROOT / 'site').glob('*.js')):
            src = f.read_text(encoding='utf-8')
            blank = NothingShippedCanWriteToZoho._code(src)
            self.assertEqual(len(blank), len(src), f'{f}: the blanker changed the offsets')
            for m in re.finditer(r'(?m)^[ \t]*//', src):
                self.assertNotIn('//', blank[m.start():m.end()],
                                 f'{f}:{src.count(chr(10), 0, m.start()) + 1} a comment is read as code')
                checked += 1
        self.assertGreater(checked, 500, f'only {checked} comment lines examined - the sweep is not sweeping')

    def test_the_blanker_keeps_what_is_not_a_comment(self):
        code = NothingShippedCanWriteToZoho._code
        self.assertIn('https://api.anthropic.com', code("const U = 'https://api.anthropic.com/v1';"))
        self.assertIn('["\']?zgid', code('const m = /(?:crmZgid|["\']?zgid["\']?)/;'))
        self.assertIn('nested', code('const t = `a ${ `nested` } b`;  // gone'))
        self.assertNotIn('gone', code('const t = `a ${ `nested` } b`;  // gone'))
        self.assertNotIn('hidden', code('/* hidden */ const x = 1;'))
        # A quote inside a comment must not open a string that swallows what follows.
        self.assertIn('fetch(BASE', code("// don't\nfetch(BASE + p);"))

    def test_the_one_non_read_helper_reaches_only_the_endpoints_named_here(self):
        # The helper is generic - `post(path, params)` - so what keeps the guarantee is not its
        # existence but its call sites. A second endpoint handed to it is a write path nobody
        # declared, and it is exactly the change this catches.
        for rel, rule in self.ALLOWED_POST.items():
            src = (ROOT / 'apps' / rel).read_text(encoding='utf-8')
            sites = [m.group(1) for m in
                     re.finditer(rule['helper'] + r"\(\s*'([^']+)'", src)]
            self.assertTrue(sites, f'{rel}: {rule["helper"]}() is never called - drop it from ALLOWED_POST')
            for path in sites:
                self.assertTrue(any(path.startswith(e) for e in rule['endpoints']),
                                f'{rel}: {rule["helper"]}() is handed {path}, which is not one of the '
                                f'endpoints declared here. Allowed because: {rule["why"]}')

    def test_the_page_world_message_is_a_hint_and_is_checked_as_one(self):
        """The one channel that crosses from the page into the extension: `hook.js` sees a save and
        posts a notice, the isolated bridge forwards it, the panel re-reads that function from Zoho.
        Anything running in the Zoho page can send it, so what matters is what it is allowed to be.

        An outside audit raised this and was half right: the target origin was '*', which is now
        `location.origin`; the receiver, which it said validated nothing, was already checking that
        the sender is this window. Both halves are asserted here because each is one edit from
        disappearing, and the shape of the check is invisible in a review of either file alone.
        """
        hook = (ROOT / 'apps' / 'crm' / 'hook.js').read_text(encoding='utf-8')
        self.assertIn('location.origin);', hook, "hook.js posts to '*' again")
        self.assertNotIn("}, '*')", hook, "hook.js posts to '*' again")
        bridge = (ROOT / 'apps' / 'crm' / 'content-bridge.js').read_text(encoding='utf-8')
        # To the end of the listener, not a fixed number of characters: a comment added inside it
        # pushed the check this looks for out of the window, and the test read as a missing guard.
        _at = bridge.index("addEventListener('message'")
        listener = bridge[_at:bridge.index("\n  });", _at)]
        self.assertIn('ev.source !== window', listener, 'the bridge accepts a message from any frame')
        self.assertRegex(listener, r"d\.source !== 'DELUGE_IDE_HOOK'", 'the bridge accepts any shape')
        self.assertRegex(listener, r'\\d\{1,20\}', 'the bridge forwards an id it has not looked at')

    # Injections into our own site are a different question from injections into Zoho's page, and the
    # rule was only ever about the second. `zoost.it/report` is filled by an injected function that
    # sets a textarea's value and dispatches an `input` event - deliberately, so the reader sees the
    # whole report in the page before anything is sent - and the check called that a driven page for
    # as long as it could see it, which was never.
    OURS = ('zoost.it',)

    def test_nothing_injected_into_the_page_drives_it(self):
        """«Never click-and-hope» as an assertion. `chrome.scripting.executeScript` is the one call
        that can put code inside Zoho's page, and the rule is that what goes in either *reads* or is
        one of our own two files. A `func:` that clicks or dispatches an event would be the synthetic
        driving this project removed in 1.1.0, arriving through a different door.

        **A `func:` passed by name is resolved to its declaration.** It used to read the call text
        only, and two of the three injection sites in this tree are `func: put` - four lines above,
        setting a value and dispatching an event. So the gate `docs/boundaries.md` cites by name as
        *the* enforcement of «nothing injected drives the page» was inspecting an identifier and
        finding no verbs in it. Reported by a scan of the boundaries; the claim in that file was false
        of the shipped code and is corrected there too.
        """
        for f in sorted((ROOT / 'apps').rglob('*.js')):
            src = f.read_text(encoding='utf-8')
            for m in re.finditer(r'executeScript\s*\(\s*\{(.*?)\}\s*\)', src, re.S):
                call = m.group(1)
                if 'files:' in call:
                    self.assertRegex(call, r"files:\s*\['(hook|content-bridge)\.js'\]",
                                     f'{f.name}: injects a file that is not one of ours')
                # `[,}]` alone missed `func: drive ` at the end of the captured call text - the
                # last argument has nothing after it. Proven by planting exactly that.
                fn = re.search(r'func:\s*([A-Za-z_$][\w$]*)\s*(?:[,}]|$)', call)
                body = call
                if fn:
                    d = re.search(r'(?m)^\s*(?:const|let|var|function)\s+' + fn.group(1) + r'\b[\s\S]{0,600}',
                                  src)
                    self.assertTrue(d, f'{f.name}: injects func: {fn.group(1)}, which is declared nowhere '
                                       'in this file - the gate cannot read what it cannot find')
                    body = d.group(0)
                if 'func:' not in call:
                    continue
                # Where it is aimed. An injection into one of our own pages may fill a form; one into
                # Zoho's page may not touch the DOM at all.
                window = src[max(0, m.start() - 1200):m.end()]
                if any(host in window for host in self.OURS):
                    continue
                for verb in ('.click(', 'dispatchEvent', '.submit(', '.value ='):
                    self.assertNotIn(verb, body,
                                     f'{f.name}: injected code drives the page ({verb}) - the rule '
                                     'is read, or reach it by URL')


class APartialListNeverLooksLikeACensus(unittest.TestCase):
    """Every page loop in the bridge has a ceiling, and every one of them reports hitting it - except
    the functions list, whose ceiling was added the day before and whose `capped` nothing read. So a
    list that stopped early arrived looking exactly like a complete one, in the area that is the whole
    product. Reported by an assistant reading the repository; the defect was mine, one commit old.

    The check is the pairing rather than the count: for each command whose answer can carry `capped`,
    the panel's caller has to mention it. A ceiling that is never spoken is worse than no ceiling -
    a runaway loop at least announces itself by never finishing.
    """

    def test_every_cap_the_bridge_can_report_is_read_by_the_panel(self):
        bridge = (ROOT / 'apps' / 'crm' / 'content-bridge.js').read_text(encoding='utf-8')
        # The panel is several files since the split, loading into one scope; the caller of a
        # bridge command may live in any of them.
        panel = '\n'.join(f.read_text(encoding='utf-8')
                          for f in sorted((ROOT / 'apps' / 'crm').glob('*.js')))
        cmds = []
        # Both shapes the dispatcher has worn: eleven copies of `{ fn().then(…) }`, and the single
        # `return reply(fn(…))` that replaced them. Reading only the first meant the derivation
        # produced *nothing* the day the bridge was tidied, and `assertTrue(cmds)` is what caught it -
        # which is the reason that line is there and not a formality.
        for m in re.finditer(r"msg\?\.cmd === '(\w+)'\)\s*(?:\{\s*)?(?:return\s+reply\()?(\w+)\(", bridge):
            cmd, fn = m.group(1), m.group(2)
            body = re.search(r'\n  async function ' + fn + r'\(.*?\n  \}', bridge, re.S)
            if body and 'capped' in body.group(0):
                cmds.append(cmd)
        self.assertTrue(cmds, 'no command reports a ceiling at all - this test now asserts nothing')
        for cmd in cmds:
            i = panel.find(f"cmd: '{cmd}'")
            self.assertGreater(i, 0, f'{cmd} is never called from the panel')
            window = panel[i:i + 4000]
            self.assertIn('capped', window,
                          f'{cmd} can stop early and the panel never says so - a partial list that '
                          'reads as a census is the one thing a mirror may not do')


class TheSensitiveHalfOfAnExportIsOptIn(unittest.TestCase):
    """«The sensitive part is opt-in and flagged when selected - Deluge source code in Zoost CRM, the
    SQL of your query tables in Zoost Analytics» - §4.3 of the privacy policy, and the same sentence
    on the CRM page and in the README. It was false: both panels initialised the export scope from
    SCOPE_FULL, so a first export carried the source unless somebody noticed the tick and cleared it.

    Found by an assistant reading the repository against the site - the check the home page now hands
    to readers - which is the argument for handing it out: nothing here compares prose against code,
    and a person re-reading their own promises does not see them.

    The test is keyed to the promise, not to the constant: what it holds is that the key naming the
    sensitive section is off in whatever the panel starts from, and that the claim still exists to be
    kept. If the claim is ever withdrawn, this fails and says so.
    """

    SENSITIVE = {'crm': 'code', 'analytics': 'sql'}

    def test_the_promise_is_still_made(self):
        privacy = (ROOT / 'site' / 'privacy.html').read_text(encoding='utf-8')
        self.assertIn('the sensitive part is opt-in', privacy,
                      'the privacy policy no longer makes the promise this test keeps')

    def test_the_first_export_does_not_carry_it(self):
        """**Both writers of the preference, not only the panel.**

        This read `sidepanel.js` and nothing else, and its second assertion - «nothing initialises a
        scope from SCOPE_FULL any more» - would have failed on `options.js` from the day it was
        written. The settings page is the other writer: it started from SCOPE_FULL, drew «Deluge
        source code» ticked over a stored preference where it is off, and one press of Save wrote that
        as chosen and stamped it with the schema version - which is precisely what stops the panel's
        one-shot migration from ever turning it off again. A check whose subject is one file, over a
        preference two files write, is a check with a hole the size of the other file.
        """
        for app, key in self.SENSITIVE.items():
            for name in ('sidepanel.js', 'options.js'):
                self._one(ROOT / 'apps' / app / name, app, key, name)

    def _one(self, path, app, key, name):
            if not path.exists():
                return
            src = path.read_text(encoding='utf-8')
            # Only a file that holds the preference is asked about it: the Analytics settings page has
            # no export section at all, and requiring a default there would be a check about a screen
            # that does not exist. The subject is «every file that builds a scope», derived by whether
            # it names SCOPE_FULL, not a list of file names.
            if 'SCOPE_FULL' not in src:
                return
            m = re.search(r'const SCOPE_DEFAULT = Object\.assign\(\{\}, SCOPE_FULL, \{([^}]*)\}\)', src)
            self.assertIsNotNone(m, f'{app}/{name}: there is no SCOPE_DEFAULT, so the scope starts from SCOPE_FULL')
            self.assertRegex(m.group(1), rf'{key}:\s*false',
                             f'{app}/{name}: {key} is not turned off in the default export scope')
            # and nothing initialises a scope from SCOPE_FULL any more - the whole point is that an
            # omitted key must not mean «include the sensitive section».
            for line in src.splitlines():
                code = line.split('//')[0]
                if 'Object.assign({}, SCOPE_FULL' in code and 'SCOPE_DEFAULT =' not in code:
                    # `pspFull` in the panel, `scFull` on the settings page: the «Everything» button,
                    # which is the one place a reader asks for the sensitive half by pressing it.
                    self.assertTrue('pspFull' in code or 'scFull' in code,
                                    f'{app}/{name}: a scope is built from SCOPE_FULL outside the '
                                    f'«Everything» button: {line.strip()[:90]}')


class AnItalianPageDoesNotSendYouToTheEnglishOne(unittest.TestCase):
    """A CTA added to the Italian homepage pointed at `/try` instead of `/it/try`, so the one button
    inviting somebody to try the product took them out of their language. Reported by the author.

    It is a whole class rather than a slip: every Italian page is written beside its English twin,
    the paths differ only by a prefix, and nothing looks wrong in the markup. So it is derived - any
    link from `site/it/` to a path that *has* an Italian version is a finding - with the two
    deliberate exceptions named: the language switch, which says `hreflang="en"` and exists to leave
    Italian, and `/llms.txt`, which is written for machines and stays in English on purpose.
    """

    def test_every_link_that_could_stay_in_italian_does(self):
        it = ROOT / 'site' / 'it'
        pages = {p.name for p in it.glob('*.html')}
        findings = []
        for p in sorted(it.glob('*.html')):
            html = p.read_text(encoding='utf-8')
            for m in re.finditer(r'<a\b[^>]*href="(/[^"#]*)"[^>]*>', html):
                tag, href = m.group(0), m.group(1)
                if href.startswith('/it/') or 'hreflang="en"' in tag or href == '/llms.txt':
                    continue
                target = (href.strip('/') or 'index') + '.html'
                if target in pages:
                    findings.append(f'site/it/{p.name}: {href} leaves Italian, and /it{href} exists')
        self.assertEqual(findings, [], '\n'.join(findings))


class TheScrollingRowDoesNotShaveItsOwnLabel(unittest.TestCase):
    """`.wsgroup` scrolls sideways when the buttons cannot fit, and `overflow-x:auto` beside an
    `overflow-y:visible` computes the visible axis to `auto` as well - so the row clips vertically
    too, which nobody asked it for. `.explabel` sits 7px above its group's border on purpose, to
    straddle it the way a fieldset legend does, and that put it 1px above the row's padding box: the
    top row of pixels of EXPORT was shaved off, in both products, everywhere the panel is drawn.

    Measured in the shipped panel rather than reasoned - label 183.3..191.3 against a padding box at
    184.3 - and reported by the author from a screenshot, which is the only way it was ever going to
    be found: it is one pixel, it is in both twins, and no check looked at geometry.

    This one does the arithmetic instead of the rendering, because that is what a suite can hold: the
    label rises `top` above the group's padding box, the group's own border earns one of those pixels
    back, and what is left has to fit in the row's top padding.
    """

    def rule(self, css: str, selector: str) -> str:
        m = re.search(re.escape(selector) + r'\{([^}]*)\}', css)
        self.assertIsNotNone(m, f'{selector} is gone - this check now asserts nothing')
        return m.group(1)

    def px(self, decls: str, prop: str) -> float:
        m = re.search(rf'(?:^|;)\s*{prop}\s*:\s*(-?[\d.]+)px', decls)
        self.assertIsNotNone(m, f'{prop} is not a pixel value in: {decls[:80]}')
        return float(m.group(1))

    def test_the_label_fits_inside_the_row_that_clips_it(self):
        for app in ('crm', 'analytics'):
            css = (ROOT / 'apps' / app / 'sidepanel.html').read_text(encoding='utf-8')
            row = self.rule(css, '.wsgroup')
            self.assertIn('overflow-x:auto', row.replace(' ', ''),
                          f'{app}: the row no longer scrolls, so this check is about nothing')
            pad_top = float(re.search(r'padding:\s*([\d.]+)px', row).group(1))
            group_border = float(re.search(r'border:\s*([\d.]+)px', self.rule(css, '.expgroup')).group(1))
            rise = -self.px(self.rule(css, '.explabel'), 'top')
            self.assertGreaterEqual(pad_top, rise - group_border,
                                    f'{app}: the label rises {rise}px, the group gives back '
                                    f'{group_border}px, and the row only has {pad_top}px of headroom '
                                    '- the top of EXPORT is being clipped')


class ThePicturesShowWhatTheProductDelivers(unittest.TestCase):
    """The Chrome Web Store listing for Zoho Analytics opened on a greyed «Retry 1 failed» chip, and
    nothing was failing: the pictures were rendered from `fixtures/`, which is generated with
    `edgeCases: true` so the tests have those states to read, and one of them is a query the
    generator writes as unreadable on purpose. Nobody who presses `+ Sample` is ever handed it.

    The same picture said «44 views» two clicks away from `site/try.html`, which describes the sample
    as 39 - a page and a photograph of two different workspaces, published together, for months. That
    contradiction is the cheap thing to check, and it is what these hold: what the product delivers
    has nothing recorded as failed, and its census is the number the page prints.
    """

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        out = subprocess.run(['node', str(ROOT / 'tools' / 'fixtures.mjs'), '--as-delivered', cls.tmp],
                             capture_output=True, text=True, cwd=ROOT)
        if out.returncode != 0:
            raise unittest.SkipTest('the generator would not run: ' + out.stderr[-300:])

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def delivered(self, name: str) -> dict:
        hit = list(pathlib.Path(self.tmp).glob('analytics/*/' + name))
        self.assertTrue(hit, f'the delivered workspace has no {name}')
        return json.loads(hit[0].read_text(encoding='utf-8'))

    def test_nothing_the_product_delivers_is_recorded_as_failed(self):
        self.assertEqual(self.delivered('lineage.json').get('failed', []), [],
                         'the delivered sample carries an unreadable item, so a picture of it shows '
                         '«Retry n failed» - which reads as the extension failing')

    def test_the_census_on_the_page_is_the_census_the_generator_writes(self):
        # site/try.html is the trust argument: it says exactly what + Sample writes. A number typed
        # there and a number the code produces are two claims about one thing.
        views = len(self.delivered('views.json')['views'])
        page = (ROOT / 'site' / 'try.html').read_text(encoding='utf-8')
        self.assertIn(f'{views} views', page,
                      f'the generator delivers {views} views and try.html says something else')

    def test_the_pictures_are_rendered_from_it_and_not_from_the_test_fixture(self):
        sh = (ROOT / 'tools' / 'shots.py').read_text(encoding='utf-8')
        self.assertIn('--as-delivered', sh, 'the renderer does not ask for the delivered workspace')
        code = '\n'.join(l for l in sh.splitlines() if not l.lstrip().startswith('#'))
        self.assertNotIn('ROOT / "fixtures"', code,
                         'a picture is being rendered from the edge-case tree again')


class NothingIsPublishedThatNobodyUses(unittest.TestCase):
    """A stale logo in a Google result sent somebody looking, and the site turned out to be right -
    every icon it serves is the current mark, byte for byte. Two things were wrong anyway.

    `site/crm-192.png` and `site/analytics-192.png` were rendered by `tools/icons.html`, deployed, and
    referenced by nothing: the unused-image check globs `*.webp`, so no icon had ever been asked the
    question. And the favicon was the one asset whose URL never changed when its bytes did, because
    `stamp.py` matched `webp|png|css|js` and not `ico` - so the mark was redrawn and the one picture
    people see first kept its old address.

    The reference universe is the part to be careful with. `site/icon.svg` is named by no page, and a
    first pass called it an orphan: it is the source every raster icon and every favicon frame is
    rendered from. Deleting it would have destroyed the ability to regenerate any of them.
    """

    def setUp(self):
        sys.path.insert(0, str(ROOT / 'tools'))
        import stamp
        self.stamp = stamp

    def test_an_icon_url_carries_its_own_digest(self):
        for ext in ('ico', 'svg'):
            self.assertRegex(self.stamp.ASSET.pattern, rf'\|{ext}[|)]',
                             f'.{ext} is outside the stamper, so its URL cannot change when it does')
        home = (ROOT / 'site' / 'index.html').read_text(encoding='utf-8')
        self.assertRegex(home, r'href="/favicon\.ico\?v=[0-9a-f]{10}"',
                         'the favicon is declared with no version')

    def test_the_manifest_icons_are_stamped_too(self):
        # It is JSON, so it went through none of the HTML path and had never been looked at.
        mf = (ROOT / 'site' / 'site.webmanifest').read_text(encoding='utf-8')
        for m in re.finditer(r'"src":\s*"([^"]+)"', mf):
            self.assertIn('?v=', m.group(1), f'{m.group(1)} in the manifest carries no digest')

    def test_every_published_icon_is_referenced_by_something(self):
        site = ROOT / 'site'
        where = [p.read_text(encoding='utf-8') for p in
                 list(site.glob('*.html')) + list((site / 'it').glob('*.html'))]
        where += [(site / 'site.webmanifest').read_text(encoding='utf-8'),
                  (ROOT / 'tools' / 'icons.html').read_text(encoding='utf-8')]
        hay = '\n'.join(where)
        for f in sorted(list(site.glob('*.png')) + list(site.glob('*.ico')) + list(site.glob('*.svg'))):
            self.assertIn(f.name, hay, f'site/{f.name} is deployed and nothing references it')

    def test_the_source_of_the_icons_is_not_treated_as_an_orphan(self):
        # The one file that would look unused by every naive measure and must never be removed.
        gen = (ROOT / 'tools' / 'icons.html').read_text(encoding='utf-8')
        self.assertIn('/site/icon.svg', gen, 'the icon generator no longer draws from site/icon.svg')
        self.assertTrue((ROOT / 'site' / 'icon.svg').is_file(),
                        'site/icon.svg is gone, and with it the source of every icon and favicon frame')

    def test_the_home_page_states_its_logo(self):
        # Without structured data Google has to guess a site's logo from the favicon, which it caches
        # for far longer than a redraw takes.
        for rel in ('site/index.html', 'site/it/index.html'):
            src = (ROOT / rel).read_text(encoding='utf-8')
            m = re.search(r'<script type="application/ld\+json">([\s\S]*?)</script>', src)
            self.assertIsNotNone(m, f'{rel} carries no structured data')
            data = json.loads(m.group(1))
            self.assertEqual(data['@type'], 'Organization')
            self.assertTrue(data['logo'].startswith('https://zoost.it/'), data['logo'])
            name = data['logo'].rsplit('/', 1)[1].split('?')[0]
            self.assertTrue((ROOT / 'site' / name).is_file(),
                            f'the declared logo {name} is not a file this site serves')
            self.assertNotIn('?v=', data['logo'],
                             'a digest here is one nothing maintains - stamp.py rewrites href, src '
                             'and og:image, never a JSON string, so it would rot in silence')


class TheTwinLedgerSaysWhereBothSidesArrived(unittest.TestCase):
    """twincheck compared how many sides of a twin pair had moved, and never whether they still
    agreed afterwards. So the expensive shape - the same fix applied to both copies, differently -
    arrived as «the ledger is 1 pair(s) behind ... then --accept», which is not merely quiet: it
    is the checker recommending the one action that records the divergence as the new normal.
    Measured against the previous version by planting that exact defect in erCovers.

    Two hashes per side, so a pair is (crm, analytics) and a state is whether they match."""

    A, B, C = ('aaaa', 1), ('bbbb', 1), ('cccc', 1)

    def report(self, now, was):
        return '\n'.join(twincheck.drift_report(now, was))

    def test_both_sides_moved_apart_from_identical(self):
        out = self.report({'f': (self.B, self.C)}, {'f': ('aaaa', 'aaaa')})
        self.assertIn('no longer agree', out, 'a fix applied twice, differently, passed as diligence')
        self.assertNotIn('--accept', out, 'it still points at the button that would make it permanent')

    def test_both_sides_moved_together_is_only_the_ledger_being_behind(self):
        # The good case, and it must stay quiet apart from the bookkeeping line - a check that
        # cannot pass is not strict, it is broken.
        out = self.report({'f': (self.B, self.B)}, {'f': ('aaaa', 'aaaa')})
        self.assertNotIn('no longer agree', out)
        self.assertIn('ledger is 1 pair(s) behind', out)

    def test_a_pair_already_divergent_is_left_alone(self):
        # Two functions that share a name. Telling them to agree would be the check inventing a
        # rule the code never had.
        out = self.report({'f': (self.B, self.C)}, {'f': ('aaaa', 'zzzz')})
        self.assertNotIn('no longer agree', out)

    def test_reconciling_a_divergent_pair_is_not_a_finding(self):
        out = self.report({'f': (self.B, self.B)}, {'f': ('aaaa', 'zzzz')})
        self.assertNotIn('no longer agree', out)

    def test_one_sided_change_still_reads_as_half_done(self):
        out = self.report({'f': (self.B, self.A)}, {'f': ('aaaa', 'aaaa')})
        self.assertIn('crm moved, analytics did not', out)


class TheMapNamesTheWholeRepository(unittest.TestCase):
    """The tree at the top of docs/layout.md named four of the eight directories, and `store/crm/`
    described itself as "per app" while `store/analytics/` appeared nowhere.

    Found by the author, reading it. Both rules it broke are written down at length here - the twins
    must not diverge, and a part enumerated once is enumerated everywhere its siblings are - and the
    file that broke them is the map of the repository. So the list is derived from disk rather than
    remembered: a directory that appears tomorrow has to be named there, and so does the second
    product's copy of anything under apps/ or store/.
    """

    def block(self):
        src = (ROOT / 'docs' / 'layout.md').read_text(encoding='utf-8')
        return src.split('```')[1]

    def test_every_directory_is_named(self):
        block = self.block()
        for d in sorted(p for p in ROOT.iterdir() if p.is_dir() and not p.name.startswith('.')):
            self.assertIn(f'{d.name}/', block,
                          f'{d.name}/ exists and the map of the repository does not name it')

    def test_both_products_are_named_wherever_one_is(self):
        block = self.block()
        for parent in ('apps', 'store'):
            for child in sorted(p for p in (ROOT / parent).iterdir() if p.is_dir()):
                self.assertIn(f'{parent}/{child.name}/', block,
                              f'{parent}/{child.name}/ is missing from the map while its twin is in it')


class NothingHerePublishes(unittest.TestCase):
    """The upload path stops at the draft, and that is a property worth holding by test.

    Every derivation and every verification is automated here; publishing is a decision, and the one
    endpoint that takes it must never appear in anything that can run on its own. It would be an easy
    line to add - the token already has the scope, since Google's grant is publisher-wide - which is
    exactly why it is checked rather than trusted to good sense.
    """

    def files(self):
        out = list((ROOT / 'tools').glob('cws*.py'))
        out += list((ROOT / '.github' / 'workflows').glob('*.yml'))
        return out

    def test_no_automation_calls_publish(self):
        for f in self.files():
            text = f.read_text(encoding='utf-8')
            code = '\n'.join(l for l in text.splitlines()
                             if not l.lstrip().startswith(('#', '*', '"""')))
            self.assertNotIn(':publish', code,
                             f'{f.relative_to(ROOT)} can publish to the Store on its own')

    def test_the_upload_refuses_over_a_review_in_progress(self):
        src = (ROOT / 'tools' / 'cwsupload.py').read_text(encoding='utf-8')
        self.assertIn('PENDING_REVIEW', src, 'the upload no longer checks what Google already has')
        self.assertIn('sys.exit', src.split('PENDING_REVIEW')[1][:400], 'it checks and carries on anyway')

    def test_the_ids_are_read_and_not_copied(self):
        # A second copy of the publisher or the extension ids is a second thing to keep in step.
        src = (ROOT / 'tools' / 'cws.py').read_text(encoding='utf-8')
        self.assertIn("_worker.js", src)
        for f in self.files():
            if f.name == 'cws.py':
                continue
            text = f.read_text(encoding='utf-8')
            self.assertNotIn('f3724a09', text, f'{f.relative_to(ROOT)} carries its own publisher id')

    def test_the_workflow_stages_but_is_never_started_by_a_push(self):
        # It runs itself once the release workflow has finished - staging a draft is reversible and
        # has no judgement left in it once the tag exists. What must not happen is a *push* putting a
        # package in front of Google: the tag is the decision, and it is checked and built first.
        wf = (ROOT / '.github' / 'workflows' / 'store-upload.yml').read_text(encoding='utf-8')
        self.assertIn('workflow_dispatch:', wf, 'the by-hand retry is gone')
        self.assertIn('workflow_run:', wf, 'nothing stages the package after a release any more')
        self.assertNotIn('\n  push:', wf, 'a push must not put a package in front of Google')
        self.assertNotIn('\n  release:', wf,
                         'on: release is raised by GITHUB_TOKEN and would never fire - use workflow_run')

    def test_a_review_in_progress_is_a_skip_only_when_asked(self):
        src = (ROOT / 'tools' / 'cwsupload.py').read_text(encoding='utf-8')
        after = src.split('PENDING_REVIEW')[1][:600]
        self.assertIn('if if_clear:', after, 'the automatic path fails over a normal state')
        self.assertIn('return 0', after)
        self.assertIn('sys.exit(said)', after, 'asked directly it no longer refuses')

    def test_the_tag_is_read_from_the_run_that_built_it(self):
        # On a workflow_run there is no `inputs.tag`; GitHub puts the tag in head_branch. Reading
        # inputs.tag alone would make every automatic run try to download a Release called "".
        wf = (ROOT / '.github' / 'workflows' / 'store-upload.yml').read_text(encoding='utf-8')
        self.assertIn('github.event.workflow_run.head_branch', wf)
        self.assertNotIn("gh release download '${{ inputs.tag }}'", wf,
                         'the download still reads an input that an automatic run does not have')



class ShippedFilesAreText(unittest.TestCase):
    """No control byte in anything we ship, because a tool that meets one stops reading.

    A single raw NUL sat in `graphlogic.js` - a fold key joined with `'\0'` typed rather than
    escaped, while the same value was written `\u0000` in four other places in the same file. It
    cost nothing at runtime and everything to a reader: `file` reported the file as data, `grep`
    treated it as binary and skipped all 31KB of it in silence, and a review of the shipped code
    came within one measurement of reporting a function as missing because grep could not see it.

    Tab, newline and carriage return are text. Everything else below 0x20 is not.
    """

    def test_no_control_bytes_in_shipped_or_site_files(self):
        allowed = {0x09, 0x0a, 0x0d}
        findings = []
        for base, globs in ((ROOT / "apps", ("*.js", "*.html", "*.json")),
                            (ROOT / "site", ("*.js", "*.html", "*.css", "*.txt", "*.json")),
                            (ROOT / "tools", ("*.py", "*.sh", "*.mjs", "*.js")),
                            (ROOT / "tests", ("*.py", "*.mjs", "*.sh"))):
            for g in globs:
                for f in base.rglob(g):
                    raw = f.read_bytes()
                    bad = {b for b in raw if b < 0x20 and b not in allowed}
                    if bad:
                        findings.append(f"{f.relative_to(ROOT)}: {[hex(b) for b in sorted(bad)]}")
        self.assertEqual(findings, [], "a control byte makes the file binary to ordinary tools")


class FindingsNotesEndInARule(unittest.TestCase):
    """A review note records the defect, the fix, and the rule that stops it coming back.

    Asked for on 20 August 2026, about a note that had been left at the repository root under the name
    of the *activity* that produced it: «what has to be tracked is the problems, the solutions and
    above all the rules that stop those anomalies happening again». The activity is over the moment it
    ends; the rule is the only part that is still worth reading a year later.

    Held mechanically because the shape is what decays: writing up eleven defects is satisfying, and
    the eleventh rule is the one that gets left out at midnight."""

    FINDINGS = ROOT / 'docs' / 'findings'

    def test_there_is_at_least_one_and_the_index_points_at_the_folder(self):
        main = (ROOT / 'CLAUDE.md').read_text(encoding='utf-8')
        self.assertIn('docs/findings', main, 'the notes exist and the index does not mention them')
        self.assertTrue(sorted(self.FINDINGS.glob('*.md')), 'docs/findings is empty')

    def test_each_file_is_dated_and_says_what_it_was(self):
        for f in sorted(self.FINDINGS.glob('*.md')):
            self.assertRegex(f.name, r'^\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$',
                             f'{f.name}: a note is YYYY-MM-DD-what-it-was.md, in English and sortable')

    def test_every_entry_ends_in_a_rule(self):
        # The three parts, in order: what broke, what was done, what stops it recurring. A note whose
        # entries stop at the fix is a changelog, and this repository has one of those already.
        for f in sorted(self.FINDINGS.glob('*.md')):
            body = f.read_text(encoding='utf-8')
            # A note may take another shape - the first one here is a reply to an outside audit, and
            # «what was refused and why» is half of its argument. What no note may lack is the rules,
            # so that is what is required of every one of them; the three-part form is held wherever
            # it is used, which is what every note written since the convention does.
            self.assertIn('rule', body.lower(), f'{f.name}: a review note with no rule in it')
            entries = [e for e in re.split(r'^#+ ', body, flags=re.M)[1:] if '**What broke.**' in e]
            self.assertTrue(entries or '## The rules it left behind' in body,
                            f'{f.name}: neither the three-part form nor a collected set of rules')
            for e in entries:
                title = e.splitlines()[0][:60]
                self.assertIn('**The rule.**', e, f'{f.name}: «{title}» stops at the fix')
                self.assertIn('**The fix.**', e, f'{f.name}: «{title}» does not say what was done')
                self.assertLess(e.index('**The fix.**'), e.index('**The rule.**'),
                                f'{f.name}: «{title}» states the rule before the fix')


class LangCheckHoldsOneLanguage(unittest.TestCase):
    """One language in the repository, and the checker that says so.

    The rule arrived on 20 August 2026 - «everything in English; Italian only on the Italian pages» -
    after a note written in Italian was found at the repository root and two `background.js` files
    were seen to have opened with an Italian comment since the first commit. A rule about language is
    the easiest of all to break here, because the author thinks in Italian, so it got a check the same
    day rather than a paragraph.

    What is asserted is the discrimination, not the tree: a word list that fires on English would be
    abandoned within a week, and one that misses Italian is decoration."""

    def _mod(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('langcheck', ROOT / 'tools' / 'langcheck.py')
        mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
        return mod

    ITALIAN = [
        '// Apre il side panel quando clicchi l\'icona della toolbar.',
        'Reported as «i colori sono utili ma non sufficienti».',
        'questa pagina non esiste',
        'devono essere allineate a sinistra',
    ]
    ENGLISH = [
        '# 50 rows per page, and the wide walk reads 200',
        'This is a non-negotiable: no write path to Zoho.',
        'come back to it later, once the pull has finished',
        'const perPage = 200;  // measured against the API',
        'a summary cache that must never outlive the folder it describes',
    ]

    def test_it_finds_italian_and_leaves_english_alone(self):
        rx = self._mod().RX
        for line in self.ITALIAN:
            self.assertTrue(rx.search(line), f'not reported as Italian: {line}')
        for line in self.ENGLISH:
            self.assertIsNone(rx.search(line), f'English reported as Italian: {line}')

    def test_the_italian_pages_are_the_only_place_it_does_not_look(self):
        m = self._mod()
        self.assertTrue(m.skipped('site/it/index.html'))
        self.assertTrue(m.skipped('tools/absolutes.txt'), 'the ledger of published claims is not exempt')
        self.assertFalse(m.skipped('apps/crm/sidepanel.js'))
        self.assertFalse(m.skipped('docs/naming.md'))
        self.assertFalse(m.skipped('site/index.html'), 'an English page is not exempt because it is a page')

    def test_a_ledger_entry_is_a_line_and_a_place(self):
        # The same sentence copied into a second file is a second finding: an accepted quotation is
        # accepted where it stands, not everywhere. And editing an accepted line un-accepts it.
        m = self._mod()
        self.assertNotEqual(m.key('docs/naming.md', 'una frase'), m.key('docs/layout.md', 'una frase'))
        self.assertNotEqual(m.key('docs/naming.md', 'una frase'), m.key('docs/naming.md', 'un altra frase'))
        self.assertEqual(m.key('docs/naming.md', ' una frase '), m.key('docs/naming.md', 'una frase'))

    def test_the_ledger_is_in_step_with_the_tree(self):
        # Being behind is itself a finding, exactly as in twincheck and csscheck: a ledger that
        # records lines which are no longer there stops being a record of anything.
        out = subprocess.run([sys.executable, str(ROOT / 'tools' / 'langcheck.py')],
                             capture_output=True, text=True, cwd=str(ROOT))
        self.assertEqual(out.returncode, 0, out.stdout)


class AsyncCheckFinds(unittest.TestCase):
    """The three shapes an audit measured as false negatives, and one control.

    The first version of `asynccheck.py` reported «0 findings, 59 recorded as read» while missing
    these - which is worse than not having it, because the number was quoted as evidence. They are
    fixtures rather than assertions about the tree: the tree changes, the shapes do not."""

    HEAD = 'let healthData = null, actionUsers = null;\nconst failedRemovals = new Set();\n'
    CASES = {
        'an assignment that is not at the start of its line':
            'async function f() {\n  await g();\n  try { healthData = 1; } catch (_) {}\n}\n',
        'a guard before the await and the write after it':
            'async function f() {\n  if (!op.current()) return;\n  actionUsers = await g();\n}\n',
        'a const collection mutated':
            'async function f() {\n  await g();\n  failedRemovals.clear();\n}\n',
    }
    CONTROL = 'async function f() {\n  await g();\n  if (!op.current()) return;\n  healthData = 1;\n}\n'

    def _run(self, body):
        import importlib.util
        spec = importlib.util.spec_from_file_location('asynccheck', ROOT / 'tools' / 'asynccheck.py')
        mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
        fd, path = tempfile.mkstemp(suffix='.js', dir=str(ROOT))
        os.write(fd, (self.HEAD + body).encode('utf-8')); os.close(fd)
        try:
            return mod.findings(os.path.basename(path))
        finally:
            os.unlink(path)

    def test_the_three_shapes_are_found(self):
        for what, body in self.CASES.items():
            with self.subTest(what):
                self.assertTrue(self._run(body), f'{what}: not reported')

    def test_a_guard_that_is_genuinely_between_is_not_a_finding(self):
        # A checker that reports everything is one nobody reads - the other half of proving it works.
        self.assertEqual(self._run(self.CONTROL), [])

class CallCheckFindsACallWithNothingToCall(unittest.TestCase):
    """A helper that exists in one panel and is *called* in the other.

    `pruneSql()` in the Analytics panel enumerated the workspace with `walk()`, which is a CRM panel
    function and has never existed there - the line was written from the CRM side. Nothing caught it:
    `node --check` accepts a free variable, the panels are not importable, and no test runs a pull. It
    threw inside the try block that marks the mirror incomplete, so a pull that had written every byte
    correctly reported «the last pull was interrupted mid-write» and the repair hit the same wall. It
    is in Zoho Analytics 1.28.0, the package Google was reviewing when this was found.

    Fixtures rather than assertions about the tree: the tree changes, the shapes do not. The second
    case is the half that is usually missing - a checker that reports everything is not a strict one,
    it is a broken one, and the two are indistinguishable until somebody needs it.
    """

    PAGE = '<!doctype html><html><body><script src="a.js"></script><script src="b.js"></script></body></html>'

    def _findings(self, files):
        import importlib.util
        spec = importlib.util.spec_from_file_location('callcheck', ROOT / 'tools' / 'callcheck.py')
        mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
        with tempfile.TemporaryDirectory() as tmp:
            app = pathlib.Path(tmp) / 'apps' / 'demo'
            app.mkdir(parents=True)
            (app / 'page.html').write_text(self.PAGE, encoding='utf-8')
            for name, body in files.items():
                (app / name).write_text(body, encoding='utf-8')
            mod.ROOT = pathlib.Path(tmp)
            return mod.scan()[0]

    def test_a_call_to_a_function_no_script_on_the_page_declares(self):
        found = self._findings({'a.js': 'async function go() { for await (const p of walk(root)) {} }\n',
                                'b.js': 'const other = () => 1;\n'})
        self.assertTrue(any('walk()' in f for f in found), found)

    def test_a_helper_in_the_other_script_of_the_same_page_is_not_one(self):
        # Two scripts on one page share a scope, which is what a browser does with classic scripts.
        found = self._findings({'a.js': 'async function go() { for await (const p of walk(root)) {} }\n',
                                'b.js': 'async function* walk(d) { yield d; }\n'})
        self.assertEqual(found, [])

    def test_the_shapes_that_declare_a_name_without_the_word_function(self):
        # Every one of these was a false finding on the first run against the real tree, and each is
        # a way this repository actually writes a declaration.
        for what, body in {
            'an object method': 'window.x = { async _db() { return 1; } };\nwindow.x._db();\n',
            'an anonymous function expression': 'window.hl = function (code, resolve) { return resolve(code); };\n',
            'an arrow parameter': 'const run = (fn) => fn();\n',
            'a destructured constant': 'const { helper } = window.lib;\nhelper();\n',
        }.items():
            with self.subTest(what):
                self.assertEqual(self._findings({'a.js': body, 'b.js': ''}), [])

    def test_a_pattern_containing_a_quote_does_not_swallow_the_file(self):
        # `/'/` read as a string blanked 54% of the CRM panel on this tool's first run, and it
        # reported 87 findings with a straight face. A regular expression is not a string.
        found = self._findings({'a.js': "const q = (s) => s.replace(/'/g, '');\nfunction later() { return q('x'); }\n",
                                'b.js': ''})
        self.assertEqual(found, [])

    def test_it_says_when_a_page_loads_a_script_that_is_not_there(self):
        found = self._findings({'a.js': 'const a = 1;\n'})   # b.js never written
        self.assertTrue(any('b.js' in f for f in found), found)


class TheAssistantsToolsAreNamedWhereTheyAreClaimed(unittest.TestCase):
    """The README listed nine of the assistant's tools and the code has eleven.

    Under-promising, so it cost nobody anything - and it is the same defect as over-promising with the
    sign flipped: a list presented as *the* list, kept by hand, that had stopped matching. Found by an
    assistant running the assessment prompt this project ships on its own site, which is the prompt
    doing exactly what it is for.

    Derived from `ai.js`, so a tool added tomorrow is required in the prose without anyone remembering
    - and a tool removed stops being required, which is the direction that keeps a ledger honest."""

    def _tools(self, rel: str) -> set:
        src = (ROOT / rel).read_text(encoding='utf-8')
        block = re.findall(r"\{\s*name:\s*'([a-z_]+)',\s*description:", src)
        self.assertTrue(block, f'{rel}: no tool definitions found - the shape moved, fix the reader')
        return set(block)

    def test_the_readme_names_every_tool_the_crm_assistant_has(self):
        readme = (ROOT / 'README.md').read_text(encoding='utf-8')
        missing = sorted(t for t in self._tools('apps/crm/ai.js') if f'`{t}`' not in readme)
        self.assertEqual(missing, [], 'README.md claims the agent\'s tools and does not name these')

    def test_the_count_in_the_prose_is_the_count_in_the_code(self):
        # The word, not the digit: this is prose. Nine became eleven and the sentence did not move.
        words = {9: 'nine', 10: 'ten', 11: 'eleven', 12: 'twelve', 13: 'thirteen'}
        for rel, page in (('apps/crm/ai.js', 'README.md'), ('apps/analytics/sidepanel.js', 'site/ai.html')):
            n = len(self._tools(rel))
            with self.subTest(rel):
                self.assertIn(words[n], (ROOT / page).read_text(encoding='utf-8'),
                              f'{page}: {rel} has {n} tools and the page never says «{words[n]}»')


class AFileCountInProseIsAClaim(unittest.TestCase):
    """A page was green because one sentence on it was right, while two others were wrong.

    `nerd.html` carried three file counts: the one the check was looking for, «twenty ... Zoho CRM»,
    and two stale ones - «eleven for Zoho Analytics» and «Twelve files for Zoho CRM and ten for Zoho
    Analytics», left from when the apps were smaller. The check searched for the *correct* word beside
    the product name and stopped at the first hit, so the stale sentence supplied the token the correct
    one was being looked for in: a checker satisfied by the very text it exists to catch. Reported by a
    reader running the assessment prompt this site ships.

    The fixture is the shape, not the tree: the counts move, the failure mode does not."""

    def _findings(self, page_text, crm_files, analytics_files):
        import importlib.util
        spec = importlib.util.spec_from_file_location('sitecheck', ROOT / 'tools' / 'sitecheck.py')
        mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            for app, n in (('crm', crm_files), ('analytics', analytics_files)):
                d = root / 'apps' / app
                d.mkdir(parents=True)
                for i in range(n):
                    (d / f'{i}.js').write_text('', encoding='utf-8')
            (root / 'site').mkdir()
            (root / 'site' / 'nerd.html').write_text(page_text, encoding='utf-8')
            mod.ROOT, mod.SITE = root, root / 'site'
            out = []
            mod.file_count_is_derived(out)
            return out

    RIGHT = '<p>Twenty files of plain JavaScript for Zoho CRM, twelve for Zoho Analytics.</p>'

    def test_a_correct_sentence_does_not_absolve_a_stale_one(self):
        page = self.RIGHT + '<p>Twelve files for Zoho CRM and ten for Zoho Analytics.</p>'
        found = self._findings(page, 20, 12)
        self.assertTrue(any('twelve' in f and 'Zoho CRM' in f for f in found), found)
        self.assertTrue(any('ten' in f for f in found), found)

    def test_every_phrasing_the_site_uses_is_read(self):
        # A comma, an «and», a number that opens the sentence: all three are on the site today, and a
        # checker that demanded one of them would be a checker that edits prose.
        for what, page in {
            'a comma': self.RIGHT,
            'an and': '<p>about twenty files for Zoho CRM and twelve for Zoho Analytics</p>',
            'opening the sentence': '<p>Twenty files for Zoho CRM and twelve for Zoho Analytics, no bundler.</p>',
        }.items():
            with self.subTest(what):
                self.assertEqual(self._findings(page, 20, 12), [])

    def test_a_number_that_counts_something_else_is_left_alone(self):
        # «nine tools» and «twelve data centres» sit beside a product name too. Only a sentence about
        # files is a claim about files.
        page = self.RIGHT + '<p>Nine tools in Zoho Analytics, and twelve data centres for Zoho CRM.</p>'
        self.assertEqual(self._findings(page, 20, 12), [])

    def test_the_count_follows_the_tree(self):
        # The point of deriving it: add a script and the prose is wrong until somebody moves it.
        self.assertTrue(self._findings(self.RIGHT, 21, 12))


class TheManualHalfOfATestIsRecordedAndGates(unittest.TestCase):
    """The author is in the release chain, and his answer has to be worth something.

    A defect that made every Pull all fail reached a submitted package, because nothing here executed
    a pull - and the parts that need a real Zoho org cannot be executed here by anyone. `probe.py`
    now runs both pulls headless; what is left is his to run, and `tools/handcheck.py` records it.

    The three properties that make it a gate rather than a ritual, each held here because each is the
    way this would rot: an answer is about a **commit** and not a version, a **failure** is sayable,
    and a shipped file that no entry covers is a **finding** - otherwise the catalogue ages into
    decoration while every run stays green."""

    def _mod(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('handcheck', ROOT / 'tools' / 'handcheck.py')
        mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
        return mod

    def test_every_entry_says_what_to_do_and_what_a_pass_looks_like(self):
        for c in self._mod().CHECKS:
            with self.subTest(c['id']):
                self.assertTrue(c['do'] and all(c['do']), f'{c["id"]}: nothing to do')
                self.assertTrue(c['covers'], f'{c["id"]}: covers nothing, so it never applies')
                # A pass has to be an observation. «Works» is a verdict, and a verdict is what the
                # person answering is being asked to avoid.
                self.assertNotRegex(c['pass'], r'\b(works|correctly|properly|fine)\b',
                                    f'{c["id"]}: says «works» where it should say what is on screen')

    def test_every_shipped_file_of_both_apps_is_covered_by_some_entry(self):
        # The derivation only helps if the catalogue spans the product. A file nobody says how to
        # exercise is exactly where the next one of these hides.
        mod = self._mod()
        for app in ('crm', 'analytics'):
            files = [f'apps/{app}/{p.name}' for p in (ROOT / 'apps' / app).glob('*.js')]
            left = mod.uncovered(app, files)
            self.assertEqual(left, [], f'{app}: no manual check covers these')

    def test_an_answer_expires_when_the_code_it_exercises_moves(self):
        mod = self._mod()
        app = 'crm'
        with tempfile.TemporaryDirectory() as tmp:
            mod.record_path = lambda a: pathlib.Path(tmp) / 'rec.json'
            mod.changed = lambda a: [f'apps/{app}/sidepanel.js']
            mod.head = lambda: 'a' * 40
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                mod.record(app, [1], 'pass', '')
                # The panel moved after he answered: the pull check is about the panel, so it expires.
                mod.changed_between = lambda a, since: [f'apps/{app}/sidepanel.js']
                rc = mod.check(app)
            self.assertEqual(rc, 1, out.getvalue())
            self.assertIn('what it exercises has changed since', out.getvalue())

    def test_an_answer_survives_a_change_it_has_nothing_to_do_with(self):
        # The first version expired every answer whenever any line moved, which is honest and
        # expensive: a fix in the diagram window sent him back to re-run a pull on a real org. An
        # answer is about the code its check exercises - and that is derivable, so it is derived.
        mod = self._mod()
        with tempfile.TemporaryDirectory() as tmp:
            mod.record_path = lambda a: pathlib.Path(tmp) / 'rec.json'
            mod.changed = lambda a: ['apps/crm/sidepanel.js']
            mod.head = lambda: 'a' * 40
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                asked = [c for c in mod.CHECKS
                         if mod.applies(c, 'crm', mod.changed('crm')) and not c.get('by')]
                mod.record('crm', list(range(1, len(asked) + 1)), 'pass', '')
                mod.changed_between = lambda a, since: ['apps/crm/graphview.js']   # nothing they touch
                rc = mod.check('crm')
            self.assertEqual(rc, 0, out.getvalue())

    def test_an_answer_outlives_the_version_it_was_given_for(self):
        # Per version was the first shape, and it threw every answer away at each bump: a release that
        # changed a label sent him back through a pull on a real org for nothing. The ledger is per
        # product, and what expires an answer is its own perimeter moving - not the version number.
        mod = self._mod()
        self.assertTrue(str(mod.record_path('crm')).endswith('store/crm/handchecks.json'),
                        'the record is named after a version, so a bump discards it')

    def test_a_failure_is_recordable_and_refuses_the_tag(self):
        mod = self._mod()
        with tempfile.TemporaryDirectory() as tmp:
            mod.record_path = lambda a: pathlib.Path(tmp) / 'rec.json'
            mod.changed = lambda a: ['apps/crm/sidepanel.js']
            mod.head = lambda: 'c' * 40
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                mod.record('crm', [1], 'fail', 'the tree came back empty')
                rc = mod.check('crm')
            self.assertEqual(rc, 1)
            self.assertIn('the tree came back empty', out.getvalue())

    def test_release_refuses_to_tag_without_it(self):
        src = (ROOT / 'tools' / 'release.sh').read_text(encoding='utf-8')
        self.assertIn('handcheck.py "$APP" --check', src,
                      'release.sh can tag over a release nobody exercised')

    def test_a_copy_of_the_tool_refuses_to_answer(self):
        # A copy on another machine has no tags and no apps/, so it would say «nothing changed,
        # nothing to run» - and an uncertified release would look certified. It has to refuse, not
        # do less. Raised by the author before it happened: «I am not sure I have an up-to-date
        # tools directory».
        with tempfile.TemporaryDirectory() as tmp:
            elsewhere = pathlib.Path(tmp) / 'tools'
            elsewhere.mkdir()
            shutil.copy2(ROOT / 'tools' / 'handcheck.py', elsewhere / 'handcheck.py')
            out = subprocess.run([sys.executable, str(elsewhere / 'handcheck.py'), 'crm'],
                                 capture_output=True, text=True)
            self.assertEqual(out.returncode, 2, out.stdout + out.stderr)
            self.assertIn('only correct inside', out.stdout)

    def test_the_plan_travels_and_the_tool_does_not(self):
        # What reaches the machine with the browser is text: derived on every sync, naming its commit,
        # and impossible to run. The tool stays where the manifest, the tags and the record are.
        sync = (ROOT / 'tools' / 'totest.sh').read_text(encoding='utf-8')
        self.assertIn('--plan-file', sync, 'the test folder gets no plan, so he tests from memory')
        self.assertNotIn('rsync $RSYNC_FLAGS tools', sync, 'the tools folder must not be mirrored')
        stamp = (ROOT / 'tools' / 'synctest.sh').read_text(encoding='utf-8')
        # A commit with no change under apps/ still moves what the plan says. Without this the file
        # over there names a commit that has moved on, which is the one thing it must never do.
        self.assertIn('git rev-parse HEAD', stamp)
        self.assertIn('tools/handcheck.py', stamp)


class AFindingCarriesWhatFixesIt(unittest.TestCase):
    """«Always put me in a position to have all the material, otherwise I have to ask and we slow
    down for nothing.»

    `dashcheck` said which dashboard field had drifted and told him to run a command to see the text -
    and he does not run commands, so it was an instruction to nobody: a finding, then a round trip,
    then the words. CLAUDE.md has said «hand me the finished text ready to paste» since long before;
    this is that rule with a machine behind it, in the one place that produces the fields.

    Held here because the failure is invisible in a green run: the finding was *correct*, and useless."""

    def test_a_field_that_differs_comes_with_the_text_that_replaces_it(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('dashcheck', ROOT / 'tools' / 'dashcheck.py')
        src = (ROOT / 'tools' / 'dashcheck.py').read_text(encoding='utf-8')
        i = src.index('elif theirs != ours:')
        block = src[i:src.index('s = state(page)', i)]
        self.assertIn('ready to paste', block, 'the finding names the field and not the words')
        self.assertIn('ours.splitlines()', block, 'nothing prints the replacement text')
        self.assertNotIn('storecopy.py', block,
                         'it still sends him to a command instead of handing over the text')


class ACheckerCountsWhatItInspected(unittest.TestCase):
    """«A tool that says 0 while not looking at a third of the surface.»

    Three findings in one outside review, two of them inside checkers, and the same shape underneath:
    a headline that counts the files opened - «32 shipped scripts, 30 pages» - and says nothing about
    what was examined inside them. `htmlcheck` inspected 148 of 210 attribute interpolations and
    printed zero, for months, truthfully.

    The mechanism that catches it is a **second, cruder scan of the same subject, compared by
    position**: the careful pass reads attribute values properly, the crude one marks every `${` that
    has an unclosed `="` behind it, and a position the crude one sees which the careful one never read
    is a finding *about the tool*, printed before any finding about the code. A crude count would prove
    nothing - it is either short or long; positions are checkable.

    These cases hold the mechanism rather than the number, because the number moves with the code."""

    def _run(self, *args):
        out = subprocess.run([sys.executable, str(ROOT / 'tools' / 'htmlcheck.py'), *args],
                             capture_output=True, text=True, cwd=str(ROOT))
        return out.returncode, out.stdout

    def test_the_headline_counts_what_was_inspected_and_not_only_the_files(self):
        _, out = self._run()
        first = out.splitlines()[0]
        self.assertRegex(first, r'\d+ attribute interpolation\(s\) inspected',
                         'the headline counts files opened, which is true and says nothing')
        self.assertIn('none left unread', first)

    def test_the_escapers_the_criterion_trusts_are_read_and_not_taken_on_their_name(self):
        # `ATTR_SAFE` approves an expression that calls `escA`. Seven escA are defined in the shipped
        # scripts; six encode `& < > " '` and the seventh encoded three of the five - harmless where
        # it stood, which is a property of its call sites and not of the function. The tool's own
        # docstring throws away a list of names on exactly this ground, and ATTR_SAFE was that list
        # one level up. Held on a fixture, because the tree changes and the shape does not.
        import importlib.util
        spec = importlib.util.spec_from_file_location('htmlcheck', ROOT / 'tools' / 'htmlcheck.py')
        mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
        weak = "const escA = (s) => String(s).replace(/&/g, '&amp;').replace(/\"/g, '&quot;');"
        full = ("const escA = (s) => String(s).replace(/[&<>\"']/g, (c) => "
                "({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[c]));")
        with tempfile.TemporaryDirectory() as tmp:
            d = pathlib.Path(tmp)
            (d / 'weak.js').write_text(weak, encoding='utf-8')
            (d / 'full.js').write_text(full, encoding='utf-8')
            mod.FILES = [d / 'weak.js']
            found = mod.weak_escapers()
            self.assertTrue(found, 'an escaper that never emits an apostrophe was approved by name')
            self.assertIn('an apostrophe', found[0])
            mod.FILES = [d / 'full.js']
            self.assertEqual(mod.weak_escapers(), [],
                             'a complete escaper is reported, so the check cries wolf')

    def test_the_reason_a_limit_gives_covers_the_ground_the_limit_claims(self):
        # The export writes a standalone document opened from file://, with no CSP and an inline
        # script - so «MV3 blocks inline scripts, therefore this is not code execution» is true of the
        # panel and not of that file. The limit stands; its reason had to stop describing everything.
        doc = (ROOT / 'tools' / 'htmlcheck.py').read_text(encoding='utf-8')
        self.assertIn('does not cover the exported report', doc,
                      'the stated reason still reads as covering every surface this tool skips')

    def test_a_narrower_pass_reports_itself_before_it_reports_the_code(self):
        # The historical defect, put back: the pattern that only matched a whole-value `${...}`.
        src = (ROOT / 'tools' / 'htmlcheck.py').read_text(encoding='utf-8')
        wide = 'r\'(\\w[\\w-]*)="([^"]{0,600}?\\$\\{[^"]{0,600}?)"\''
        self.assertIn(wide, src, 'the pattern moved - fix this case rather than deleting it')
        narrow = 'r\'(\\w[\\w-]*)="(\\$\\{[^}]*\\})"\''
        with tempfile.TemporaryDirectory() as tmp:
            spare = pathlib.Path(tmp) / 'htmlcheck.py'
            shutil.copy2(ROOT / 'tools' / 'htmlcheck.py', spare)
            (ROOT / 'tools' / 'htmlcheck.py').write_text(src.replace(wide, narrow), encoding='utf-8')
            try:
                rc, out = self._run()
            finally:
                shutil.copy2(spare, ROOT / 'tools' / 'htmlcheck.py')
        self.assertEqual(rc, 1, out)
        self.assertIn('NOT LOOKED AT', out.splitlines()[0])
        self.assertIn('this checker does not look here', out,
                      'it went quiet about its own blind spot, which is what this exists to stop')


class TheBranchThatGetsTaggedIsChecked(unittest.TestCase):
    """`main` was red for the length of somebody else's review, and nothing said so.

    The battery was a *release* gate: `release.yml` runs it before it builds, with a comment saying two
    minutes there makes those checks unskippable. True of the tag. But CI ran on tags and on nothing
    else, so the branch that gets tagged could sit red indefinitely, and the moment anyone found out
    was the first `git push --follow-tags` - a release half-cut over a branch nobody had verified.

    It happened for the most ordinary reason there is: a file edited after the last local run and
    committed without another. The local rule is right and had already been broken, which is this
    repository's own definition of a rule that needs a check behind it."""

    WF = ROOT / '.github/workflows/battery.yml'

    def test_the_battery_runs_on_a_push_to_the_default_branch(self):
        self.assertTrue(self.WF.exists(), 'nothing runs the suite between a commit and a tag')
        wf = self.WF.read_text(encoding='utf-8')
        self.assertRegex(wf, r'push:\s*\n\s*branches: \[main\]', 'it does not fire on a push to main')
        self.assertIn('bash tests/run.sh', wf, 'it fires and runs something else')

    def test_it_pins_its_actions_like_every_other_workflow(self):
        # A tag is a ref its owner can repoint; the rest of this repository pins to a commit and says
        # which release it was. A new workflow is exactly where that slips.
        for f in sorted((ROOT / '.github/workflows').glob('*.yml')):
            for line in f.read_text(encoding='utf-8').splitlines():
                if 'uses:' not in line or line.strip().startswith('#'):
                    continue
                self.assertRegex(line, r'uses: [^@]+@[0-9a-f]{40}',
                                 f'{f.name}: an action is pinned to a moving ref')

    def test_the_live_audit_is_deliberately_not_in_it(self):
        # auditcheck's live half says nothing until a push has landed, and its claims ledger is read
        # and accepted as part of finishing a piece of work - so on push it would be red for ordinary
        # reasons, and a red mark that is usually noise teaches everyone to ignore the mark.
        wf = self.WF.read_text(encoding='utf-8')
        self.assertNotIn('auditcheck.py', wf.split('jobs:')[1],
                         'the push workflow runs auditcheck, which will be red for ordinary reasons')
        self.assertIn('auditcheck', wf.split('jobs:')[0], 'the omission is not explained')


class CssScannerReadsEveryRule(unittest.TestCase):
    """The checker read 1318 of the 1487 rules in this tree and printed «0 findings».

    Two shapes were invisible, and one of them was worse than invisible. A rule whose body ran onto a
    second line was dropped whole - the reader required a line to end in `}` and threw away the
    selector it had accumulated when it did not. And two rules on one line, `a{x}b{y}`, were read as
    one: `a` took `x}b{y` as its declarations, so its body was wrong *and* `b` was never seen.

    The remedy is the one this repository already built for `htmlcheck`: a second, cruder pass over
    the same subject, compared by position. Every `{` in the file has to fall on a rule the careful
    scan read or inside a span it consciously skipped; one that does not is a finding about the tool,
    printed above any finding about the CSS.
    """

    def setUp(self):
        import importlib
        self.c = importlib.import_module('csscheck')

    def test_a_rule_whose_body_spans_lines_is_read(self):
        rules, _ = self.c.scan('.a{\n  color: red;\n  margin: 0;\n}\n.b{color:blue}\n')
        self.assertEqual([r[0] for r in rules], ['.a', '.b'])
        self.assertIn('margin: 0', rules[0][1])

    def test_two_rules_on_one_line_are_two_rules(self):
        rules, _ = self.c.scan('.a{color:red} .b{color:blue}\n')
        self.assertEqual([(r[0], r[1]) for r in rules], [('.a', 'color:red'), ('.b', 'color:blue')],
                         'the second rule is invisible and the first one carries it')

    def test_a_comment_above_a_rule_is_not_part_of_its_selector(self):
        # `[hidden]` arrived carrying the four-line note that explains it, and so became a selector
        # nothing else could ever match.
        rules, _ = self.c.scan('/* why this exists\n   over two lines */\n[hidden]{display:none}\n')
        self.assertEqual(rules[0][0], '[hidden]')

    def test_a_string_in_a_declaration_survives_the_comparison(self):
        # Blanking strings before comparing bodies would make these two agree, which is a divergence
        # reported as agreement - the opposite of the tool's job.
        a, _ = self.c.scan('.x{content:"a"}')
        b, _ = self.c.scan('.x{content:"b"}')
        self.assertNotEqual(a[0][1], b[0][1])

    def test_a_brace_inside_a_string_is_not_structure(self):
        rules, _ = self.c.scan('.x{content:"}"}\n.y{color:red}\n')
        self.assertEqual([r[0] for r in rules], ['.x', '.y'],
                         'a closing brace in a string ended the rule and lost the rest of the file')

    def test_an_at_rule_block_is_skipped_and_accounted_for(self):
        css = '@media (max-width:600px){.a{color:red}}\n.b{color:blue}\n'
        rules, _ = self.c.scan(css)
        self.assertEqual([r[0] for r in rules], ['.b'], 'a breakpoint reads as a second definition')
        self.assertEqual(self.c.unread(css), [], 'the braces inside the at-rule are unaccounted for')

    def test_the_coverage_audit_speaks_when_the_careful_pass_goes_blind(self):
        # A checker that says nothing about what it skipped is the defect being fixed, so the audit
        # itself gets both proofs: silent on the tree, and loud the moment the careful pass narrows.
        css = '.a{\n  color: red;\n}\n.b{color:blue} .c{color:green}\n'
        self.assertEqual(self.c.unread(css), [], 'the shipped scanner cannot account for its own file')
        real = self.c.scan
        try:
            self.c.scan = lambda text: ([], [])          # a pass that reads nothing at all
            self.assertEqual(len(self.c.unread(css)), 3, 'a scan that reads nothing is reported as complete')
        finally:
            self.c.scan = real

    def test_the_tree_has_no_unread_rule(self):
        for _, where, css in self.c.sheets():
            self.assertEqual(self.c.unread(css), [], f'{where}: a rule this check never reads')


class StoreCopySeesEverySection(unittest.TestCase):
    """Every numbered section of a listing must be read by the tool that hands it over.

    `storecopy` prints one dashboard box on the clipboard and `--changed` says which boxes moved since
    the last submission; `dashcheck` diffs the dashboard against these texts. All three read the same
    parser, and that parser required a fenced body:

        ^## (\\d+)\\. ...\\n\\n```\\n(?P<body>.*?)\\n```

    **Section 10 has no fence.** It is the data-disclosure section - the checkboxes and the one
    sentence Google is told about what leaves the machine, which is a compliance statement rather than
    marketing copy - and it was therefore compared by nothing. It drifted for two days in the CRM
    listing, still saying «Nothing is sent to the developer» after the problem report shipped, and the
    sweep that corrected its twin did not see it either.

    So: the denominator comes from the headings, by a cruder method than the parser, and a section the
    parser skips is a finding about the tool. The same shape as `htmlcheck` and `csscheck`.
    """

    def setUp(self):
        import importlib
        self.sc = importlib.import_module('storecopy')

    def test_no_numbered_section_is_skipped(self):
        for app in ('crm', 'analytics'):
            f = ROOT / 'store' / app / 'store-listing.md'
            written = {int(m.group(1)) for m in re.finditer(r'(?m)^## (\d+)\.', f.read_text(encoding='utf-8'))}
            read = {n for n, _, _, _ in self.sc.sections(app)}
            self.assertGreaterEqual(len(written), 9, f'{app}: only {len(written)} sections found - the sweep broke')
            self.assertEqual(sorted(written - read), [],
                             f'{app}: storecopy never reads section(s) {sorted(written - read)}, so nothing '
                             f'compares them against the dashboard and nothing says when they drift')


class TheTwoHostListsAgree(unittest.TestCase):
    """Where a content script is injected, and where the extension may reach, are two lists.

    `content_scripts[].matches` decides where the bridge runs. `host_permissions` decides where it may
    fetch - and in Analytics the bridge derives its own «am I on Analytics» verdict from the second:

        const IS_ANALYTICS = (chrome.runtime.getManifest().host_permissions || [])
          .filter((h) => h.startsWith('https://analytics.'))
          .some((h) => h.replace(/[/][*]$/, '') === BASE);

    So a data centre added to `matches` and not to `host_permissions` injects a script that recognises
    nothing: every command returns false and the panel says «No answer from the Zoho Analytics page» -
    a sentence naming a cause nobody could reach from it. The two lists agree today and nothing held
    them there; planted, and the battery stayed green.

    One direction only, and the reason is the asymmetry itself: `host_permissions` legitimately holds
    hosts no content script runs on - `zoost.it`, the two AI providers - while a `matches` entry with
    no permission behind it is always wrong.
    """

    def test_every_injected_host_is_a_permitted_host(self):
        for mf in sorted(ROOT.glob('apps/*/manifest.json')):
            m = json.loads(mf.read_text(encoding='utf-8'))
            allowed = set(m.get('host_permissions', []))
            injected = {h for c in m.get('content_scripts', []) for h in c.get('matches', [])}
            self.assertTrue(injected, f'{mf.parent.name}: no content script matches at all')
            self.assertEqual(sorted(injected - allowed), [],
                             f'{mf.parent.name}: the bridge is injected where the extension has no host '
                             f'permission, so it will load and recognise nothing')


class AsyncCheckReadsWhatItOpens(unittest.TestCase):
    """The ledger holds 79 sites and the tool read none of the two files that fetch from Zoho.

    Both `content-bridge.js` are wrapped in an IIFE, so every function in them is indented by two,
    and the finder was anchored at column zero: **0 of 32 and 0 of 19**, over 42 `await`s. The
    headline said «20 files» and the ledger's header said in writing that the content scripts «were
    read before being recorded». They were opened. `tests/slice.mjs` learnt this on this exact file.

    The crude denominator is every `function` declaration at any indentation; the careful pass reads
    the file's own top level, which is column zero normally and the IIFE's body where there is one.
    The difference is the functions nested inside another, whose state is local - and that number is
    printed rather than left as a silence.
    """

    def setUp(self):
        import importlib
        self.a = importlib.import_module('asynccheck')

    def test_it_reads_the_two_files_that_reach_zoho(self):
        for rel in ('apps/crm/content-bridge.js', 'apps/analytics/content-bridge.js'):
            src = (ROOT / rel).read_text(encoding='utf-8')
            self.assertTrue(self.a._iife(src), f'{rel} is no longer an IIFE - the reader assumes one')
            n = len(list(self.a.functions(src)))
            self.assertGreater(n, 10, f'{rel}: the checker reads {n} functions in a file that has dozens')
            self.assertGreater(len(self.a.globals_of(src)), 5,
                               f'{rel}: the checker sees no shared state in a file that has plenty')

    def test_the_wrapper_is_detected_from_the_first_statement(self):
        # The loose version matched any line beginning with «(» and called `sidepanel.js` wrapped,
        # then looked for functions at indentation two and found none - 79 sites down to 30, with
        # nothing on screen saying so.
        self.assertFalse(self.a._iife((ROOT / 'apps/crm/sidepanel.js').read_text(encoding='utf-8')))
        self.assertTrue(self.a._iife('/* c */\n(function () {\n  function f() {}\n})();'))
        self.assertFalse(self.a._iife('// c\nlet x = 1;\n(function () {})();'))

    def test_almost_every_declared_function_is_read(self):
        # A count was the first version of this - «no more than five unread» - and it aged into a
        # number nobody could check: the day two more legitimate nested helpers appeared it failed,
        # and the only way to satisfy it was to raise a ceiling with no argument behind it. What is
        # actually meant is a *property*: a declaration at a file's own top level is read, and one
        # nested inside another function is not, because its state is local. Name the exceptions
        # instead of counting them, and the case says what it wants.
        read = crude = 0
        unread = []
        for rel in self.a.FILES:
            src = (ROOT / rel).read_text(encoding='utf-8')
            got = {n for n, _, _ in self.a.functions(src)}
            read += len(got)
            for m in re.finditer(r'(?m)^([ \t]*)(?:async\s+)?function\s+(\w+)\s*\(', src):
                crude += 1
                if m.group(2) not in got:
                    unread.append((rel, m.group(2), len(m.group(1))))
        self.assertGreater(crude, 700, 'the crude sweep found almost nothing - it is not sweeping')
        flat = [(r, n) for r, n, indent in unread if indent == 0]
        self.assertEqual(flat, [],
                         f'these are declared at a file\'s own top level and this tool never enters '
                         f'them, so nothing it prints is about them: {flat}')


class NothingIsPushedThatTheBatteryHasNotSeen(unittest.TestCase):
    """Three checks here derive their answer from git, so a run before the commit cannot see it.

    `sitemap.py` reads each page's last-commit date for `lastmod`; `stamp.py` writes the «updated»
    date on the guides from the same source; `sitecheck --retranslated` moves the translation markers
    against a digest of the English page. All three change their answer **at the moment of the
    commit** - and on 23 August the date rolled over between a green battery and the push. The commit
    moved four pages into the new day, and `main` went red on a tree that had passed thirty seconds
    earlier.

    No amount of care fixes that: the input did not exist when the check ran. What fixes it is running
    the battery on the commit, which is what `tools/hooks/pre-push` does - and it refuses if the
    battery leaves derived files changed behind, because those belong in the commit being pushed.
    """

    HOOK = ROOT / 'tools' / 'hooks' / 'pre-push'

    def test_the_hook_is_in_the_repository_and_executable(self):
        self.assertTrue(self.HOOK.exists(), 'tools/hooks/pre-push is gone')
        self.assertTrue(os.access(self.HOOK, os.X_OK), 'the hook is not executable, so git ignores it')

    def test_it_runs_the_battery_and_refuses_leftovers(self):
        src = self.HOOK.read_text(encoding='utf-8')
        self.assertIn('bash tests/run.sh', src, 'the hook does not run the battery')
        self.assertIn('git diff --quiet', src,
                      'the hook does not refuse a commit the battery left derived changes against')
        self.assertIn('exit 1', src, 'the hook cannot refuse anything')

    def test_every_git_derived_check_is_named_in_the_hook(self):
        # Derived: whichever tool reads a commit date is one whose answer the commit itself changes,
        # and the hook's own comment must name it - so a fourth added tomorrow is not a silent
        # member of the class that caused this.
        derived = set()
        for f in sorted((ROOT / 'tools').glob('*.py')):
            src = f.read_text(encoding='utf-8')
            if re.search(r"git['\"].{0,80}log|%ad|committer|last-commit", src, re.S):
                derived.add(f.stem)
        self.assertGreaterEqual(len(derived), 2, f'only {len(derived)} git-derived tools found - the sweep broke')
        hook = self.HOOK.read_text(encoding='utf-8')
        missing = sorted(d for d in derived if d not in hook and d not in ('whatsnew', 'release', 'auditcheck',
                                                                          'handcheck', 'submitted', 'matrix'))
        self.assertEqual(missing, [],
                         f'these read git and so change their answer when the commit is made, and the '
                         f'hook does not mention them: {missing}')


class DatesAreOneClock(unittest.TestCase):
    """A page's «updated» date comes from one clock, whichever branch produced it.

    `stamp.py` had two branches and a clock each: an uncommitted file read UTC, a committed one read
    `%cs`, which git prints in the offset recorded **on the commit**. Between UTC midnight and the
    committer's own midnight the two disagree by a day, so the checker said «says 22, it is 23»
    before a commit and «says 23, it is 22» after one - a battery that cannot converge, at the one
    hour of the day nobody is looking, and the reason CI last went red over a date nobody had typed.

    The first version of this case compared two runs under two timezones and passed on the defect:
    `%cs` does not move with `TZ`, so it measured something the bug does not do. It is measured on a
    commit **built for it** instead - a fixed instant recorded at +14:00, whose local day and UTC day
    are different by construction - so the disagreement is deterministic rather than a property of
    what time it happens to be here.
    """

    def test_a_committed_date_is_read_in_utc_like_todays(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('stamp_under_test', ROOT / 'tools' / 'stamp.py')
        stamp = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(stamp)
        with tempfile.TemporaryDirectory() as d:
            repo = pathlib.Path(d)
            env = {**os.environ, 'GIT_AUTHOR_DATE': '2026-01-02T10:00:00+14:00',
                   'GIT_COMMITTER_DATE': '2026-01-02T10:00:00+14:00',
                   'GIT_AUTHOR_NAME': 'T', 'GIT_AUTHOR_EMAIL': 't@e',
                   'GIT_COMMITTER_NAME': 'T', 'GIT_COMMITTER_EMAIL': 't@e'}
            (repo / 'f.txt').write_text('x', encoding='utf-8')
            for cmd in (['init', '-q'], ['add', 'f.txt'], ['commit', '-qm', 'x']):
                subprocess.run(['git', '-C', str(repo)] + cmd, env=env, capture_output=True, text=True)
            stamp.ROOT = repo
            # 2026-01-02 10:00 at +14:00 is 2026-01-01 20:00 UTC. `today` is UTC, so this must be too.
            self.assertEqual(stamp.git_date('f.txt'), '2026-01-01',
                             'a committed date is read in the committer\'s offset while an uncommitted '
                             'one is read in UTC - the two branches disagree by a day around midnight '
                             'and the stamps oscillate')

    def test_it_reports_a_date_at_all(self):
        # A gate that always agrees is not strict, it is broken: the case above would also pass if
        # the tool returned '' for everything. This is the half that proves it can speak.
        out = subprocess.run([sys.executable, str(ROOT / 'tools' / 'stamp.py'), '--check'],
                             cwd=ROOT, capture_output=True, text=True,
                             env={**os.environ, 'TZ': 'UTC'})
        self.assertRegex(out.stdout, r'\d{4}|stamp', 'stamp.py --check says nothing at all')

class OneProductUnreadableIsNotAReading(unittest.TestCase):
    """The Store reading is written whole or not at all.

    `storestatus.py` promises, in its own docstring, that «a failure never overwrites a good
    reading»: if Google cannot be asked it exits non-zero, the workflow goes red without writing, and
    what is in KV stands. That holds for a *total* failure - `cws.call` raises SystemExit on any HTTP
    error - and did not hold for a partial one. `shape()` returns None for an answer carrying neither
    revision status, which is the case it was written for, and `main()` then put that None in the
    payload and exited 0. The workflow PUTs one key, so the whole reading is replaced: the product
    that could not be read goes to «unknown» on every page, and `asOf` advances.

    That last part is what makes it destructive rather than merely lossy. A date that stopped
    advancing is the only signal this design has that the pipeline broke; publishing a partial
    reading keeps the date moving while the number is gone, so the failure is invisible in the one
    place built to show it.

    Both halves are proven here: it refuses a partial answer, and it accepts a complete one - a gate
    that always refuses looks identical to a strict one until somebody needs it.
    """

    ANSWER = {'publishedItemRevisionStatus': {'state': 'PUBLISHED',
                                              'distributionChannels': [{'crxVersion': '1.2.3'}]}}

    def _run(self, unreadable):
        """storestatus.main() against a stubbed Google. Returns (exit code, payload or None)."""
        import importlib
        stub = types.ModuleType('cws')
        stub.key_from_env = lambda *a, **k: {}
        stub.token = lambda *a, **k: 'stub-token'
        # A 200 carrying neither revision status - which is what `shape` exists to survive.
        stub.status = lambda tok, app: {} if app in unreadable else self.ANSWER
        with tempfile.TemporaryDirectory() as d:
            out = pathlib.Path(d) / 'status.json'
            saved, savedargv = sys.modules.get('cws'), sys.argv
            sys.modules['cws'] = stub
            sys.path.insert(0, str(ROOT / 'tools'))
            try:
                mod = importlib.import_module('storestatus')
                importlib.reload(mod)
                sys.argv = ['storestatus.py', '--out', str(out)]
                try:
                    code = mod.main()
                except SystemExit as e:
                    code = e.code if isinstance(e.code, int) else 1
                return code, (json.loads(out.read_text(encoding='utf-8')) if out.exists() else None)
            finally:
                sys.argv = savedargv
                sys.modules.pop('storestatus', None)
                if saved is None:
                    sys.modules.pop('cws', None)
                else:
                    sys.modules['cws'] = saved

    def test_it_refuses_to_publish_a_reading_missing_a_product(self):
        code, payload = self._run(unreadable={'analytics'})
        self.assertNotEqual(code, 0,
                            'one product unreadable and the reading is published anyway - the other '
                            'product\'s good number in KV is replaced and asOf advances, so the only '
                            'signal that anything broke keeps saying all is well')
        self.assertIsNone(payload, 'it wrote the file it was about to refuse')

    def test_it_publishes_a_complete_one(self):
        code, payload = self._run(unreadable=set())
        self.assertEqual(code, 0, 'a complete answer is refused - the gate always says no')
        self.assertIsNotNone(payload, 'nothing was written')
        for app in self.APPS():
            self.assertIsNotNone(payload.get(app), f'{app} missing from a reading that was accepted')

    def APPS(self):
        return sorted(d.name for d in (ROOT / 'apps').iterdir() if (d / 'manifest.json').exists())

    def test_the_products_it_asks_about_are_the_products_that_exist(self):
        # Derived from the shipped manifests, not from a list here: a third product added tomorrow
        # is covered without anyone remembering this file. The reading is one key for the whole
        # suite, so a product the tool never asks about is a product the site can only call unknown.
        src = (ROOT / 'tools' / 'storestatus.py').read_text(encoding='utf-8')
        asked = sorted(re.findall(r"'(\w+)'", re.search(r'^APPS = \(([^)]*)\)', src, re.M).group(1)))
        self.assertEqual(asked, self.APPS(),
                         'the tool asks Google about a different set of products than the ones that '
                         'ship - the reading would be missing one, or carry one that does not exist')


class AsyncCheckReadsWhatShips(unittest.TestCase):
    """Every script that ships or is served is in `asynccheck`'s subject, or is a declared exclusion.

    The subject was derived from the extensions - each page's script tags, plus the service worker
    and content-script worlds out of each manifest - and stopped there. The three scripts the site
    serves were outside it entirely, `site/_worker.js` among them with 23 awaits, and nothing said
    so. Nothing was wrong in them; this file's whole subject is the difference between «there is
    nothing there» and «nobody looked», and the headline «790 function(s) read of 792 declared»
    reads as the first while meaning neither.

    Derived from `git ls-files`, which is a cruder enumeration than the tool's own: a script added
    under `apps/` or `site/` tomorrow is either read or named, and there is no third state.
    """

    def subject(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('ac_under_test', ROOT / 'tools' / 'asynccheck.py')
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    def test_no_shipped_or_served_script_is_outside_it_unannounced(self):
        mod = self.subject()
        shipped = [f for f in subprocess.run(['git', '-C', str(ROOT), 'ls-files', '*.js'],
                                             capture_output=True, text=True).stdout.split()
                   if f.startswith(('apps/', 'site/'))]
        self.assertGreater(len(shipped), 25, 'the crude enumeration broke - it found almost nothing')
        # The shared libraries are the one declared exclusion, and the tool names them in a pattern
        # rather than a list, so this asks the pattern rather than restating it.
        outside = [f for f in shipped if f not in mod.FILES and not mod._LIB.search(f)]
        self.assertEqual(outside, [],
                         f'these ship or are served and no scope reads them, and they are not the '
                         f'declared library exclusion either: {outside}')

    def test_it_says_how_much_of_the_other_axis_it_skips(self):
        # A count of functions says nothing about how much of each one is read. `await` and `.then(`
        # are one class in two spellings and only the first is examined - so the run states the
        # second's size. A blind spot that prints its own size is a limit; one that does not is what
        # this repository has now met four times.
        out = subprocess.run([sys.executable, str(ROOT / 'tools' / 'asynccheck.py')],
                             cwd=ROOT, capture_output=True, text=True)
        self.assertRegex(out.stdout, r'\d+ \.then\(\) callback\(s\) NOT read',
                         'the run does not say how many yield sites it skipped')
        # «N await(s) read» was that sentence until it was measured: it counted every `await` token
        # in the subject files, and the tool reads declarations - so one inside an async IIFE or an
        # `= async () => {}` was counted as read and never entered. The wording has to distinguish
        # the two, which is what the class beside this one plants both halves of.
        self.assertRegex(out.stdout, r'\d+ await\(s\) inside a scope this reads, \d+ NOT read',
                         'it does not separate the awaits it entered from the ones merely present')


class ShotsSaysTheSameThingOnBothPaths(unittest.TestCase):
    """Whether the images match the listing does not depend on the path taken, nor on their bytes.

    Two defects, one sentence. `shots.py` skips rendering when the sources have not moved, and on
    that path printed «unchanged, the five published images are still what this renders» while the
    render path printed the comparison against `store/<app>/screenshots.json` - what the listing
    carries. Different questions; «published» made the first read as the second. Both appeared in
    one minute over identical bytes, and which you saw depended on whether the folder was warm.

    And the comparison itself was of the produced **bytes**. A capture is not bit-exact - measured
    over four runs of an unchanged tree: 27de, 37cf, 37cf, 92d5 - so it said «upload all five
    again» at random. `siteimg.py` had measured the same thing and written it down; the tool one
    directory over was doing what that docstring forbids. The verdict is taken from the source
    digests now, which is what the pictures are *of*.
    """

    def _run(self, recorded_sources, stamp_now):
        import importlib.util
        spec = importlib.util.spec_from_file_location('shots_under_test', ROOT / 'tools' / 'shots.py')
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        with tempfile.TemporaryDirectory() as t:
            d = pathlib.Path(t)
            (d / 'dist' / 'store' / 'crm').mkdir(parents=True)
            for n in (1, 2):
                # Deliberately different bytes on every call, because the bytes must not decide.
                (d / 'dist' / 'store' / 'crm' / f'{n}.png').write_bytes(os.urandom(32))
            if stamp_now is not None:
                (d / 'dist' / 'store' / '.stamps').mkdir(parents=True)
                (d / 'dist' / 'store' / '.stamps' / 'crm.json').write_text(
                    json.dumps(stamp_now), encoding='utf-8')
            (d / 'store' / 'crm').mkdir(parents=True)
            rec = {'version': '9.9.9', 'digest': 'deadbeefdeadbeef'}
            if recorded_sources is not None:
                rec['sources'] = recorded_sources
            (d / 'store' / 'crm' / 'screenshots.json').write_text(json.dumps(rec), encoding='utf-8')
            mod.ROOT = d
            return mod.against_listing('crm', ['a', 'b'])

    def test_the_bytes_do_not_decide(self):
        # Same sources on both sides, different bytes every time this runs. The old criterion would
        # have said CHANGED here, for ever, over pictures nobody could tell apart.
        out = self._run({'a': 'x', 'b': 'y'}, {'a': 'x', 'b': 'y'})
        self.assertIn('unchanged', out, out)

    def test_and_it_still_says_so_when_the_product_moved(self):
        # The other half: a verdict that always says «unchanged» is not reassuring, it is broken.
        out = self._run({'a': 'x', 'b': 'y'}, {'a': 'x', 'b': 'MOVED'})
        self.assertIn('CHANGED', out, out)

    def test_a_record_with_no_sources_says_it_cannot_tell(self):
        # Every listing recorded before this existed. «Cannot tell» is the honest answer and the one
        # this project prefers to a guess - and it says what will make it answerable.
        out = self._run(None, {'a': 'x'})
        self.assertIn('cannot tell', out, out)
        self.assertIn('submitted.py', out, 'it says nothing about how to make it answerable')

    def test_the_skip_path_prints_the_same_sentence_as_the_render_path(self):
        # Derived from the source, because running both paths means rendering ten images. The two
        # conclusions must come from the one function, so taking the fast path cannot change the
        # answer - which is exactly what it did.
        src = (ROOT / 'tools' / 'shots.py').read_text(encoding='utf-8')
        calls = len(re.findall(r'against_listing\(', src))
        self.assertGreaterEqual(calls, 3, f'only {calls} mention(s) - one path does not print it')
        skip = re.search(r'if not force and current\(app, keys\):(.*?)want = \[', src, re.S)
        self.assertIsNotNone(skip, 'the skip branch has moved - this check no longer reads it')
        self.assertIn('against_listing', skip.group(1),
                      'the fast path concludes about an app without saying whether the images on '
                      'disk are the ones the listing carries')
        # In a `say(`/`print(`, not anywhere: the comment above `against_listing` quotes the old
        # sentence as the evidence for why it went, which is how this repository records a defect.
        # The first version of this forbade the string outright and fired on that quotation - a
        # check whose subject is «the file» when what it means is «what the file says».
        printed = re.findall(r'(?:say|print)\([^\n]*published images are still what this renders', src)
        self.assertEqual(printed, [],
                         'the sentence that meant «the files in dist/» by «published» is printed again')

    def test_what_records_an_upload_writes_the_sources_too(self):
        # The pair: a verdict read from `sources` is worthless if nothing ever writes it.
        src = (ROOT / 'tools' / 'submitted.py').read_text(encoding='utf-8')
        self.assertIn("'sources'", src,
                      'submitted.py records a listing without what the pictures are of, so the '
                      'verdict above can only ever say «cannot tell»')


class OneProductRenderedDoesNotDeleteTheOther(unittest.TestCase):
    """A `dist/store` holding one product must not empty the other one on the mirror.

    `totest.sh` mirrors the screenshots with `--delete`, which is right - the destination is a copy
    and has to match. It synced the whole `dist/store/` in one call, and `shots.py` writes a
    product's folder only when **all five** of its shots came back, so a run where one product's
    shots failed - or a named subset, or a fresh checkout where `dist/` is git-ignored and empty -
    leaves that folder holding one product. Measured before the fix: ten pngs on the destination,
    five in the source, five left afterwards. The images deleted are the ones on the other product's
    live listing, on the machine with the dashboard open, by a run of the battery.

    The whole-folder case was already reasoned about and guarded - «a run that has not rendered any
    leaves whatever is over there alone» - one level above where the products are distinct. Same
    reasoning, applied per product now.

    This measures rsync rather than the script, deliberately: the script always runs against the
    real repository, and making `dist/store` partial to test it would mean deleting a set that
    cannot be recovered from git. The flags are read out of the script, never retyped.
    """

    def flags(self):
        line = next(l for l in (ROOT / 'tools' / 'totest.sh').read_text(encoding='utf-8').splitlines()
                    if l.startswith('RSYNC_FLAGS='))
        return line.split('"')[1].replace('$COMPARE', '--checksum').split()

    def test_the_delete_is_scoped_to_the_product_being_copied(self):
        if not shutil.which('rsync'):
            self.skipTest('no rsync here - what this asserts about is what rsync --delete removes')
        with tempfile.TemporaryDirectory() as t:
            d = pathlib.Path(t)
            (d / 'src' / 'crm').mkdir(parents=True)
            for app in ('crm', 'analytics'):
                (d / 'dst' / app).mkdir(parents=True)
            for n in range(1, 6):
                (d / 'src' / 'crm' / f'{n}.png').write_text('new', encoding='utf-8')
                for app in ('crm', 'analytics'):
                    (d / 'dst' / app / f'{n}.png').write_text('old', encoding='utf-8')
            # What the script does now: one call per product folder that exists.
            subprocess.run(['rsync', *self.flags(), str(d / 'src' / 'crm') + '/',
                            str(d / 'dst' / 'crm') + '/'], capture_output=True, check=True)
            left = sorted(p.relative_to(d / 'dst').as_posix() for p in (d / 'dst').rglob('*.png'))
            self.assertEqual(len(left), 10,
                             f'copying one product removed the other one\'s images: {left}')
            self.assertEqual((d / 'dst' / 'crm' / '1.png').read_text(encoding='utf-8'), 'new',
                             'and it did not even copy the product it was given')

    def test_the_script_copies_one_product_at_a_time(self):
        # Derived: the destination path handed to rsync must name a product, or the call is the
        # whole-folder one again. Read as a shape rather than as a string, so a rename does not
        # quietly retire the check.
        sh = (ROOT / 'tools' / 'totest.sh').read_text(encoding='utf-8')
        calls = re.findall(r'rsync \$RSYNC_FLAGS ([^\n]+)', sh)
        store = [c for c in calls if 'store' in c]
        self.assertTrue(store, 'nothing mirrors the screenshots at all any more')
        for c in store:
            self.assertNotRegex(c, r'dist/store/\s',
                                f'the whole screenshot folder is synced in one --delete call: {c}')
            self.assertIn('$DEST/store/$', c,
                          f'the destination does not name a product, so --delete reaches both: {c}')


class TheSyncStampMeansTheCopyHappened(unittest.TestCase):
    """A mark that says «done» is set only after the thing it speaks for returned.

    `synctest.sh` skips its work when nothing under `apps/` is newer than a stamp, which is what
    makes it cheap enough to run after every tool call. It ran the copy as `... || true` and then
    wrote the stamp unconditionally - so a failure (the share unreachable, the sync client on the
    host stopped, the disk full) advanced the stamp anyway and every later call saw «nothing to do».
    One failure ended the hook, silently, leaving the folder Chrome loads from at whatever it last
    received: the exact defect this file was written to fix, in the file that fixes it.

    Third instance of one class in this repository - `updateMetaIndex` clearing a dirty mark over a
    refused write, the report endpoint's KV counter, this - which is why it is held by a check and
    not by a paragraph.

    Measured by making the copy fail: `totest.sh` is called through `PATH`, so a stub named `bash`
    would reach too far; the destination is pointed at a path that cannot be written instead, which
    is the failure this actually protects against.
    """

    def _run(self, dest, home):
        env = {**os.environ, 'ZOOST_TEST_DIR': dest, 'HOME': home}
        return subprocess.run(['bash', str(ROOT / 'tools' / 'synctest.sh')],
                              cwd=ROOT, capture_output=True, text=True, env=env)

    def test_a_failed_copy_leaves_no_stamp_and_says_so(self):
        stamp = ROOT / '.git' / 'zoost-lastsync'
        failed = ROOT / '.git' / 'zoost-lastsync.failed'
        keep = stamp.read_bytes() if stamp.exists() else None
        keep_f = failed.read_bytes() if failed.exists() else None
        try:
            stamp.unlink(missing_ok=True)
            failed.unlink(missing_ok=True)
            with tempfile.TemporaryDirectory() as t:
                # A file where the folder should be: the parent exists, so the script gets past its
                # «is it mounted» check and fails on the write, which is the real-world shape.
                blocked = pathlib.Path(t) / 'mirror'
                blocked.write_text('not a directory', encoding='utf-8')
                out = self._run(str(blocked), t)
            self.assertFalse(stamp.exists(),
                             'the stamp was written over a copy that failed, so nothing will try '
                             'again and the mirror stays behind for ever')
            self.assertIn('the mirror was not written', out.stderr,
                          f'it failed and said nothing: {out.stderr!r}')
        finally:
            stamp.unlink(missing_ok=True)
            failed.unlink(missing_ok=True)
            if keep is not None:
                stamp.write_bytes(keep)
            if keep_f is not None:
                failed.write_bytes(keep_f)

    def test_it_does_not_repeat_itself_once_per_tool_call(self):
        # The other half of saying it: this hook fires after every tool call, and the same line a
        # hundred times is a wall nobody reads - which fails the same way silence does.
        stamp = ROOT / '.git' / 'zoost-lastsync'
        failed = ROOT / '.git' / 'zoost-lastsync.failed'
        keep = stamp.read_bytes() if stamp.exists() else None
        keep_f = failed.read_bytes() if failed.exists() else None
        try:
            stamp.unlink(missing_ok=True)
            failed.unlink(missing_ok=True)
            with tempfile.TemporaryDirectory() as t:
                blocked = pathlib.Path(t) / 'mirror'
                blocked.write_text('not a directory', encoding='utf-8')
                first = self._run(str(blocked), t)
                second = self._run(str(blocked), t)
            self.assertIn('the mirror was not written', first.stderr)
            self.assertEqual(second.stderr.strip(), '',
                             f'it says the same thing on every tool call: {second.stderr!r}')
        finally:
            stamp.unlink(missing_ok=True)
            failed.unlink(missing_ok=True)
            if keep is not None:
                stamp.write_bytes(keep)
            if keep_f is not None:
                failed.write_bytes(keep_f)


class LedgersSayWhichWayTheyMoved(unittest.TestCase):
    """«The ledger may only shrink» was stated eleven times and enforced nowhere - and it is false.

    Five tools keep a ledger and every one of them says it, as do three places in `CLAUDE.md`.
    Nothing was behind any of the eleven: `--accept` records whatever is there and prints the new
    total, so a ledger that grew and one that shrank print the same shape of line. Measured from
    git: `notenglish.txt` has grown on **every** commit that touched it (33, 38, 39, 41, 42, 43);
    `asyncglobals.txt` went from 52 entries to 79 in one step; `cssdupes.txt`, the one the rule was
    written for, fell 86 to 35 and then grew to 38.

    The prose was also wrong to be absolute, which is the more useful half. A ledger grows for two
    reasons that are identical in the file: new debt was accepted, or **the check started seeing
    more**. The 52 -> 79 jump was the second - `asynccheck` learnt to read inside an IIFE and found
    two content bridges it had scored as empty - and refusing that growth would have refused the
    fix. So the direction is printed, and the commit says which reason.
    """

    LEDGERS = ('cssdupes.txt', 'notenglish.txt', 'asyncglobals.txt', 'attrraw.txt')

    def helper(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('ledger_under_test', ROOT / 'tools' / 'ledger.py')
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    def test_it_names_the_direction_and_the_size(self):
        m = self.helper()
        self.assertIn('MORE', m.delta('x', 5, 8), 'growth reads the same as anything else')
        self.assertIn('shrank', m.delta('x', 8, 5))
        self.assertIn('unchanged', m.delta('x', 5, 5))

    def test_every_tool_with_a_ledger_reports_the_direction(self):
        # Derived from the tools that write one, not from a list: a fifth added tomorrow is a
        # finding here until it says which way its file moved.
        writers = []
        for f in sorted((ROOT / 'tools').glob('*.py')):
            src = f.read_text(encoding='utf-8')
            if re.search(r'LEDGER\s*=|LEDGER\.write_text|open\(LEDGER', src) and '--accept' in src:
                writers.append(f)
        self.assertGreaterEqual(len(writers), 4, f'only {len(writers)} ledger tool(s) found - the sweep broke')
        silent = [f.name for f in writers if 'ledger_delta(' not in f.read_text(encoding='utf-8')]
        self.assertEqual(silent, [],
                         f'these rewrite a ledger and never say whether it grew or shrank: {silent}')

    def test_an_accept_keeps_what_it_did_not_write(self):
        # `asyncglobals.txt` carried nineteen hand-written lines - which entries are cache
        # invalidations, why the options pages are recorded rather than exempted, what the tool
        # cannot see - and a regenerating `--accept` deleted every one of them without a word. Found
        # by doing it: the file invites an explanation and then throws it away.
        m = self.helper()
        with tempfile.TemporaryDirectory() as t:
            f = pathlib.Path(t) / 'led.txt'
            own = ['# generated header']
            f.write_text('# generated header\n# somebody explained this one\nentry\n', encoding='utf-8')
            self.assertEqual(m.keep_comments(f, own), ['# somebody explained this one'])
            self.assertEqual(m.count(f), 1, 'comments are counted as entries')

    def test_the_ledger_that_carries_reasoning_still_carries_it(self):
        # The real file, because the case above proves the helper and this proves it is wired in.
        led = ROOT / 'tools' / 'asyncglobals.txt'
        self.assertGreater(sum(1 for l in led.read_text(encoding='utf-8').splitlines()
                               if l.startswith('#')), 10,
                           'the explanation of why those entries are safe is gone - an --accept ate it')

    def test_no_tool_still_states_the_absolute_the_measurement_disproved(self):
        # Grep the claim, not the paragraph: it was in five tools and three places in CLAUDE.md, and
        # correcting the one in front of you is how a repository ends up contradicting itself.
        left = []
        # `ledger.py` is exempt, by name and with its reason: that file *is* the record of the
        # disproof, so the old rule is quoted in it several times in the course of explaining why it
        # went. Detecting «quoted» from «stated» by the words around it was tightened twice and got
        # narrower each time without getting truer - which this repository says to stop doing and
        # write the limit into the test instead.
        for f in list((ROOT / 'tools').glob('*.py')) + [ROOT / 'CLAUDE.md']:
            if f.name == 'ledger.py':
                continue
            src = f.read_text(encoding='utf-8')
            for m_ in re.finditer(r'may only shrink', src):
                line = src[:m_.start()].count('\n') + 1
                # A quotation of the old rule inside an explanation of why it went is the record
                # this repository keeps; what is refused is stating it as the rule.
                # Both sides of it: a disclaimer can precede the quotation or follow it, and the
                # first version of this only looked behind - so it reported three passages that
                # said, one line down, exactly why the rule had gone.
                near = src[max(0, m_.start() - 400):m_.start() + 400]
                if not re.search(r'was stated|disproved|measured false|used to say|it is false|no longer',
                                 near):
                    left.append(f'{f.name}:{line}')
        self.assertEqual(left, [],
                         f'the absolute is still stated as the rule in: {left}')


class EveryCheckerIsRunOrSaysWhyNot(unittest.TestCase):
    """A checker nothing runs cannot be told from one that always passes.

    Fourteen tools here report findings. Eleven are in `tests/run.sh`; three are deliberately not -
    `auditcheck` needs the network, `handcheck` needs a person on a real org, `dashcheck` needs a
    page saved out of a dashboard Google exposes no API for. All three reasons are good and only one
    of the three was written down where somebody would meet it: `auditcheck` says so in its own
    docstring, and the other two had their reason in `CLAUDE.md`, in a paragraph about releases.

    That is the same shape as everything else in this grid - one of a set treated one way and its
    siblings left as they were - and the cost is specific: a checker written tomorrow and never
    wired in reports zero for ever, which is indistinguishable on screen from a clean tree.

    The set is derived from what a tool *prints*, not from its name: anything that reports
    «finding(s)» or «difference(s)» is a checker. The limit, stated rather than left to be found:
    `deadcode.py` and `coverage.py` report neither - they are sweeps that produce candidates and
    counts - so they are outside this and outside the battery, deliberately and by their own
    docstrings.
    """

    def checkers(self):
        out = []
        for f in sorted((ROOT / 'tools').glob('*.py')):
            src = f.read_text(encoding='utf-8')
            if 'finding(s)' in src or 'difference(s)' in src:
                out.append(f)
        return out

    def test_the_sweep_finds_them(self):
        n = len(self.checkers())
        self.assertGreaterEqual(n, 12, f'only {n} checker(s) found - the derivation broke')

    def test_each_is_in_the_battery_or_says_why_it_is_not(self):
        run = (ROOT / 'tests' / 'run.sh').read_text(encoding='utf-8')
        silent = []
        for f in self.checkers():
            if f.name in run:
                continue
            doc = ast.get_docstring(ast.parse(f.read_text(encoding='utf-8'))) or ''
            # The reason has to name the battery, so «it is slow» in passing does not count: what a
            # reader needs to know is that nothing runs this unless they do.
            if not re.search(r'tests/run\.sh', doc):
                silent.append(f.name)
        self.assertEqual(silent, [],
                         f'these report findings, nothing runs them, and they do not say so: {silent}')

    def test_and_the_ones_in_the_battery_really_are_run(self):
        # The other half: a name appearing in run.sh inside a comment would satisfy the case above
        # while running nothing. Every checker named there must be on a line that executes it.
        run = (ROOT / 'tests' / 'run.sh').read_text(encoding='utf-8')
        executed = {m for line in run.splitlines() if not line.strip().startswith('#')
                    for m in re.findall(r'tools/(\w+)\.py', line)}
        named = {f.stem for f in self.checkers()}
        wired = sorted(named & executed)
        self.assertGreaterEqual(len(wired), 10,
                                f'only {len(wired)} checker(s) actually executed by the battery: {wired}')


class TheGridSaysHowFarAlongItIs(unittest.TestCase):
    """The count of closed cells is a fraction, not a remainder, and it reaches the commit subject.

    Fifteen commits carried «33 cells left» in their *body*. `git log --oneline` therefore showed no
    progress at all, and a remainder with no denominator cannot say whether a run is a third done or
    nearly finished - so a reader of the log sees work trailing off. The subjects before them read
    «Cell 30 of 80: ...», which says both. Reported by Ivan, reading the log; the form had drifted by
    being remembered rather than derived.

    So the tool prints the next subject, and this holds the shape. The denominator moves when a cell
    is declared not-applicable, which is why it is computed and never typed - the earlier subjects
    say «of 80» and were correct when they were written.
    """

    def report(self):
        return subprocess.run([sys.executable, str(ROOT / 'tools' / 'matrix.py')],
                              cwd=ROOT, capture_output=True, text=True).stdout

    def open_cells(self):
        out = self.report()
        m = re.search(r'\*\*(\d+) left\.\*\*', out)
        self.assertIsNotNone(m, f'the report no longer says how much is left:\n{out}')
        return int(m.group(1)), out

    def test_it_hands_over_the_next_subject(self):
        # **Both forms.** The counter has been dropped twice: once moved into the body as a bare
        # remainder, once left off entirely on a commit that recorded a cell as examined rather than
        # closed. Each time `git log --oneline` stopped showing progress. A tool that hands over only
        # the closing form invites the second of those again.
        #
        # And with nothing left it must offer **neither**, which is the case that arrived the day the
        # grid was finished: `len(CLOSED) + 1` was «Cell 88 of 87», a subject that is read and copied,
        # carrying the one number a reader of the log uses to tell progress from drift. It nearly went
        # into the last commit of the grid.
        left, out = self.open_cells()
        if not left:
            self.assertNotRegex(out, r'Cell \d+ of \d+',
                                f'a subject is offered for a cell that does not exist:\n{out}')
            self.assertIn('there is no next subject', out,
                          f'the report goes quiet instead of saying the grid is finished:\n{out}')
            return
        self.assertRegex(out, r'Cell \d+ of \d+, examined:',
                         f'no subject is offered for a commit that examines a cell:\n{out}')
        m = re.search(r'Cell (\d+) of (\d+): <what broke>', out)
        self.assertIsNotNone(m, f'the tool does not hand over a subject line:\n{out}')
        n, total = int(m.group(1)), int(m.group(2))
        self.assertLessEqual(n, total, 'the next cell is past the end of the grid')
        self.assertGreater(n, 1, 'the numerator is not counting what is already closed')

    def test_the_numbers_are_derived_from_the_grid(self):
        # Not a second opinion: the same two values the report's own headline states. A subject that
        # could disagree with the grid it comes from would be worse than none.
        left, out = self.open_cells()
        # «real cells» since the unit became (class, surface, capability) - the headline says what a
        # cell now is, and this reads the same words rather than a shape it used to have.
        head = re.search(r'(\d+) real cells?\.', out)
        closed = re.search(r'(\d+) closed by a plant', out)
        self.assertTrue(head and closed, out)
        self.assertEqual(int(head.group(1)) - int(closed.group(1)), left,
                         'the headline does not add up: closed plus left is not the grid')
        if not left:
            return
        nxt = re.search(r'Cell (\d+) of (\d+):', out)
        self.assertTrue(nxt, out)
        self.assertEqual(int(nxt.group(2)), int(head.group(1)),
                         'the subject names a different total from the grid')
        self.assertEqual(int(nxt.group(1)), int(closed.group(1)) + 1,
                         'the subject does not number the cell that is about to be closed')


class StoreCeilingsAreCountedAndTheGapIsPrinted(unittest.TestCase):
    """The listing checker says how many fields it measured, and which it did not.

    «Every store field states its own ceiling, and `sitecheck.py` counts» - written after a
    justification sat over 1000 characters for an unknown length of time with nothing measuring. It
    was half true. The careful pass matched `(max N)` in parentheses of its own, and §2 reads
    «(manifest `description`, max 132)», so **the ceiling on the short description was stated and
    never enforced** - the most-read sentence this project has. Found by a cruder count of the same
    file disagreeing with it: 6 of 10 numbered sections measured, and nobody could have known.

    Three still have no ceiling - the item name, the detailed description and the data disclosures -
    and the run now prints that rather than reporting zero over a subset. What their real limits are
    is a fact about somebody else's dashboard, which nothing here can establish; the tool says it is
    not checking them instead of implying it is.
    """

    def run_it(self):
        return subprocess.run([sys.executable, str(ROOT / 'tools' / 'sitecheck.py')],
                              cwd=ROOT, capture_output=True, text=True).stdout

    def test_the_short_description_ceiling_is_enforced(self):
        # The specific one that was invisible. Read off behaviour: a copy of the file with §2 made
        # too long must be reported, whatever the heading's punctuation looks like.
        with tempfile.TemporaryDirectory() as t:
            md = ROOT / 'store' / 'crm' / 'store-listing.md'
            keep = md.read_text(encoding='utf-8')
            (pathlib.Path(t) / 'keep.md').write_text(keep, encoding='utf-8')
            try:
                body = re.search(r'## 2\. [^\n]*\n+```\n(.*?)\n```', keep, re.S)
                self.assertIsNotNone(body, 'section 2 is not shaped as this reads it')
                md.write_text(keep.replace(body.group(1), 'x' * 200, 1), encoding='utf-8')
                out = self.run_it()
                # The *finding*, not the section number. `§2` alone also appears in the «NOT
                # checked» line this same run prints, so the first version of this passed with the
                # narrow pattern restored - a check fooled by its own other output.
                self.assertRegex(out, r'§2[^\n]*is 200 characters',
                                 f'a 200-character short description is not reported:\n{out}')
            finally:
                md.write_text(keep, encoding='utf-8')

    def test_it_says_how_much_of_the_file_it_measured(self):
        out = self.run_it()
        m = re.search(r'(\d+) of (\d+) numbered section\(s\) measured', out)
        self.assertIsNotNone(m, f'the run does not say how much of the listing it checked:\n{out}')
        done, total = int(m.group(1)), int(m.group(2))
        self.assertLess(done, total + 1)
        self.assertRegex(out, r'NOT checked',
                         'it measures a subset and no longer says which sections it skipped')

    def test_and_it_would_go_quiet_if_every_section_had_one(self):
        # A line that always prints is decoration. This is the half that proves it is conditional -
        # a listing whose sections all state a ceiling must produce no gap line at all.
        with tempfile.TemporaryDirectory() as t:
            src = (ROOT / 'store' / 'crm' / 'store-listing.md').read_text(encoding='utf-8')
            every = re.findall(r'(?m)^## (\d+)\. ([^\n]*)$', src)
            self.assertTrue(every, 'the crude enumeration finds no numbered section')
            capped = [n for n, h in every if 'max ' in h]
            self.assertLess(len(capped), len(every),
                            'every section states a ceiling, so the gap line can never be exercised '
                            '- if that becomes true, this case is what has to change')


class DriftFromTheSubmittedListingIsSaid(unittest.TestCase):
    """What the repository says and what the Store was told are compared, and the answer is printed.

    `auditcheck` compared §1 and §2 against the manifest - their authority - and said «2 store fields
    compared». §3 to §10 have no authority but *what was pasted*, which `submitted.py` records in
    `store/<app>/listing.json`, and nothing looked at it. So the release gate could pass while five
    sections in the repository said something the Store had never been told, and `CLAUDE.md` records
    exactly that: §4 and §5 drifted for four and nine days while the Store still served an absolute
    the site had already walked back.

    Measured when this was written: CRM §3, §7, §10 and Analytics §3, §10 had drifted, and the only
    way to know was to run a command by hand.

    A **note and never a finding**. Drift is the normal state between an edit and the next
    submission; a gate here would refuse every release that improved the copy, which is the
    always-refuses failure this repository names. What was missing was the sentence, and it carries
    the command that prints the text, so it can be acted on where it is read.
    """

    def report(self, *args):
        return subprocess.run([sys.executable, str(ROOT / 'tools' / 'auditcheck.py'), '--offline', *args],
                              cwd=ROOT, capture_output=True, text=True).stdout

    def test_the_run_says_which_sections_drifted(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('storecopy_ut', ROOT / 'tools' / 'storecopy.py')
        sc = importlib.util.module_from_spec(spec); spec.loader.exec_module(sc)
        out = self.report()
        for app in sorted(d.name for d in (ROOT / 'apps').iterdir() if (d / 'manifest.json').exists()):
            drifted = sc.changed_sections(app)
            self.assertIn(f'store/{app}:', out, f'the run says nothing at all about {app}\n{out}')
            if drifted:
                for n in drifted:
                    self.assertRegex(out, rf'store/{app}:[^\n]*§?{n}\b',
                                     f'{app} §{n} has drifted and the run does not name it')
                self.assertRegex(out, rf'store/{app}:[^\n]*storecopy\.py {app}',
                                 f'{app} drift is reported without the command that prints the text')

    def test_it_is_a_note_and_not_a_finding(self):
        # The half that keeps it usable: a release must not be refused because the copy improved.
        # Read off *where the sentence appears*, not off the finding count - `--offline` reports its
        # own skipped live comparison as a finding by design, so the count is never zero here and
        # the first version of this asserted against it and failed for the wrong reason.
        out = self.report()
        under = out[:out.index('auditcheck:')] if 'auditcheck:' in out else out
        self.assertNotIn('differ from what was last pasted', under,
                         'drift against the submitted listing is reported above the notes, so it '
                         'would refuse every release that changed the copy')
        self.assertIn('differ from what was last pasted', out,
                      'the drift sentence is not printed at all')

    def test_nothing_submitted_yet_is_not_everything_drifted(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('storecopy_ut2', ROOT / 'tools' / 'storecopy.py')
        sc = importlib.util.module_from_spec(spec); spec.loader.exec_module(sc)
        with tempfile.TemporaryDirectory() as t:
            root = pathlib.Path(t)
            (root / 'store' / 'crm').mkdir(parents=True)
            (root / 'store' / 'crm' / 'store-listing.md').write_text(
                '## 1. Item name\n\n```\nZoost\n```\n', encoding='utf-8')
            sc.ROOT = root
            self.assertEqual(sc.changed_sections('crm'), [],
                             'an unrecorded listing reads as «everything drifted», which is a '
                             'different fact from «nobody has submitted yet»')


class TheProbeSaysHowMuchItDrove(unittest.TestCase):
    """«Both panels navigate as documented» was printed after four scripted scenarios.

    The probe drives a panel in a real browser and is the only thing here that does - «a correct
    helper called from the wrong place still passes» is why it exists, and every case in it is a
    defect that happened. What it is not is coverage: measured, it clicks **10 of the 89** clickable
    controls in the CRM panel and **7 of 79** in Analytics, and ended with a sentence about the
    guides that reads as a statement about the whole product.

    The rule this repository applies to anything that inspects a tree - print what was inspected and
    derive the denominator by a cruder method - had reached `htmlcheck`, `asynccheck`,
    `featurecheck`, `csscheck` and `samplecheck`, and not the one tool that runs the product.

    The denominator over-counts on purpose: a control the probe reaches by a selector rather than by
    id reads as undriven. For a number whose job is to stop a sentence sounding complete, too low is
    the safe direction, and it is said here rather than left to be found.
    """

    def probe(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('probe_ut', ROOT / 'tools' / 'probe.py')
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    def test_it_counts_what_it_drove_against_what_there_is(self):
        cov = self.probe().coverage()
        self.assertGreaterEqual(len(cov), 2, f'only {len(cov)} app(s) measured - the derivation broke')
        for app, drove, total in cov:
            self.assertGreater(total, 20, f'{app}: only {total} controls found - the crude count broke')
            self.assertGreater(drove, 0, f'{app}: the probe is credited with driving nothing')
            self.assertLessEqual(drove, total, f'{app}: drove more than exists')

    def test_the_run_prints_it_and_claims_nothing_wider(self):
        src = (ROOT / 'tools' / 'probe.py').read_text(encoding='utf-8')
        printed = [l for l in src.splitlines() if 'print(' in l and 'probe:' in l]
        self.assertTrue(printed, 'the run no longer says anything at the end')
        # Refused where it is **printed**, not where it is written: the note above `coverage()`
        # quotes the old sentence as the evidence for why it went, which is how this repository
        # records a defect. Forbidding the string outright has now fired on that kind of quotation
        # three times in one day - here, in the ledger check and in the pdfTitle one - so the rule
        # is worth stating as a class: a check about what a tool *says* reads its output lines.
        said = [l for l in src.splitlines() if 'print(' in l]
        self.assertEqual([l for l in said if 'navigate as documented' in l], [],
                         'the run claims the panels navigate as documented, which four scripted '
                         'scenarios cannot establish')
        self.assertIn('of the {total} clickable controls', src.replace('f"', '"'),
                      'the run does not print how much of the panel it drove')


class TheExportedReportsContentIsLedgered(unittest.TestCase):
    """The one document with an inline script and no CSP has its content read by something.

    `htmlcheck` checks attribute interpolations and says, honestly, that it does not check element
    content: in the panel MV3 refuses inline script, so markup injection is not code execution. That
    reason is right about the panel and wrong about `apps/crm/export.js`, which writes a standalone
    report opened from `file://`, with no content-security policy and an inline `<script>` of its
    own - and the docstring already said so, after an outside review pointed it out.

    What was left was a gap with a note on it. An outside review read all of them once by hand and
    found them clean; «one reading is not an audit» is this repository's own sentence, and nothing
    read the interpolations added since - including several added today.

    So it is a ledger, exactly like `attrraw.txt`: 424 content interpolations, ~207 inert by syntax,
    the rest recorded with their expression. Being in it means «present when the ledger was made»,
    not «a person read this line» - said in the file, because the alternative is a header that
    claims a reading nobody did.
    """

    def run_it(self, *args):
        return subprocess.run([sys.executable, str(ROOT / 'tools' / 'htmlcheck.py'), *args],
                              cwd=ROOT, capture_output=True, text=True)

    def test_it_counts_the_content_it_looked_at(self):
        out = self.run_it().stdout
        m = re.search(r'(\d+) content interpolation\(s\) in the exported report; (\d+) inert by '
                      r'syntax, (\d+) recorded', out)
        self.assertIsNotNone(m, f'the run says nothing about the exported report:\n{out}')
        total, inert, recorded = (int(g) for g in m.groups())
        self.assertGreater(total, 100, 'the enumeration broke - a report of this size has hundreds')
        self.assertEqual(inert + recorded, total, 'the three numbers do not add up')

    def test_a_new_one_is_a_finding(self):
        # Run, not read: a content interpolation nobody recorded must fail the check.
        f = ROOT / 'apps' / 'crm' / 'export.js'
        keep = f.read_text(encoding='utf-8')
        try:
            f.write_text(keep.replace('<h2 id="functions">Functions</h2>',
                                      '<h2 id="functions">Functions ${plantedHere}</h2>', 1),
                         encoding='utf-8')
            out = self.run_it()
            self.assertNotEqual(out.returncode, 0, 'a new content interpolation passes unread')
            self.assertIn('plantedHere', out.stdout, out.stdout[-400:])
        finally:
            f.write_text(keep, encoding='utf-8')

    def test_and_the_tree_as_it_stands_is_green(self):
        # The other half: a ledger that refuses everything is not strict, it is broken.
        self.assertEqual(self.run_it().returncode, 0,
                         'the check refuses the tree it was just built from')

    def test_the_ledger_does_not_claim_a_reading_nobody_did(self):
        head = (ROOT / 'tools' / 'exportraw.txt').read_text(encoding='utf-8')[:900]
        self.assertIn('not** that somebody read that line', head,
                      'the ledger header claims each line was read by a person, and they were '
                      'recorded wholesale')


class ExaminedIsNotClosed(unittest.TestCase):
    """A cell somebody measured and found clean is recorded, and still counted as open.

    Five cells were examined in one day and found to have no defect - every flag in the assistant
    owned by its generation, every absolute on the options page true of the code, both store
    listings carrying the same claims. None of that was written anywhere the grid could see, so the
    next session would have re-derived all five from nothing.

    Recording them as *closed* would have been worse: the grid would then claim a check that does
    not exist, which is the one thing it is built to refuse. So there is a third state, it prints as
    `~`, and it is inside the open count - an unchecked cell is unchecked however carefully it was
    read.
    """

    def matrix(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('matrix_ut', ROOT / 'tools' / 'matrix.py')
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    def test_examined_cells_are_still_open(self):
        # Empty is the finished state, not a broken one: every cell that was merely looked at has
        # since been closed by a plant, which is what EXAMINED exists to make possible rather than to
        # replace. It was asserted non-empty while the grid still had open cells, and that assertion
        # went red the day the last one was promoted - the check outliving the state it was written
        # in. What has to hold either way is the separation below.
        m = self.matrix()
        for cell in m.EXAMINED:
            self.assertNotIn(cell, m.CLOSED,
                             f'{cell} is recorded both as examined and as closed - «somebody looked» '
                             f'must never be able to pass for «a plant is caught»')
            self.assertNotIn(cell, m.NA, f'{cell} is examined and declared not-applicable')

    def test_each_says_what_was_measured_and_when(self):
        # A note that says «checked, fine» is the opinion this grid exists to replace. What is worth
        # keeping is what was measured, so the next reader can disagree with it.
        m = self.matrix()
        for cell, value in m.EXAMINED.items():
            self.assertEqual(len(value), 2, f'{cell}: expected (what was measured, when)')
            what, when = value
            self.assertGreater(len(what), 60, f'{cell}: «{what}» does not say what was measured')
            self.assertRegex(when, r'^\d{4}-\d{2}-\d{2}$', f'{cell}: no date on the examination')

    def test_the_open_list_hands_over_what_was_already_found(self):
        # Only while there is something open to hand over. With none, the list is empty and saying
        # «LOOKED AT» about nothing would be the assertion, not the report, being wrong.
        m = self.matrix()
        if not m.EXAMINED:
            return
        out = subprocess.run([sys.executable, str(ROOT / 'tools' / 'matrix.py'), '--open'],
                             cwd=ROOT, capture_output=True, text=True).stdout
        self.assertIn('LOOKED AT', out,
                      'the open list does not say which cells were already measured, so the next '
                      'session re-derives them from nothing')


def _code_only(src):
    """Comments and literal text blanked, code kept, every position preserved.

    One left-to-right pass, because the two-regex idiom - block comments, then line comments, then
    strings - has a hole in *both* orders, and one of them is live in this repository.
    `site/_worker.js` has a line comment containing `/api/*`, so blanking block comments first opens
    a fake block at those two characters and swallows 2,746 characters of real code. Turning the
    order round trades it for a worse one: every `'https://...'` contains `//`. Measured over the
    shipped scripts, the first order swallows code in three files.

    The `${...}` of a template literal is **kept**: an interpolation is code, and a first version of
    this blanked backticked strings whole and reported zero over the very expression it was written
    for. Blanked characters become spaces and newlines are kept, so a position here is a position in
    the source.

    **Regex literals, and the sentence here that claimed there were none.** This said «there is none
    in this repository whose body contains a comment opener - measured, not assumed». It had not been
    measured, and there are two: ``.replace(/```/g, ...)`` in `apps/crm/export.js` and
    ``/`([^`]+)`/g`` in `site/site.js`, each of which opened a template literal that then swallowed
    whole functions. The claim was the defect; the hole was its consequence. It reads them now, by
    the same heuristic `tools/jstext.py` has used here for as long - the significant character before
    the slash - which is allowed to be a heuristic because the only thing riding on it is whether a
    `/*` opens a comment, and both answers leave the positions intact.

    A `/*` and a `//` are excluded from that branch by hand, because the first widening did not do so
    and read the opener of `/** The one writer of ...functions/` as a regex - a closing slash inside a path
    in the prose - which lost 535 code lines in `sidepanel.js` against the 2 the narrow version lost.
    Measuring caught it; reading it would not have.
    """
    out = []
    i, n = 0, len(src)
    prev = ''                                    # last significant character of *code*
    blank = lambda t: re.sub(r'[^\n]', ' ', t)
    # A `/` after one of these opens a regex rather than dividing - `tools/jstext.py`'s own list.
    regex_after = set('=(,:[!&|?{};+-*%~^<>')
    while i < n:
        c = src[i]
        if (c == '/' and i + 1 < n and src[i + 1] not in '*/' and (prev == '' or prev in regex_after)):
            j, cls, ok = i + 1, False, False
            while j < n:
                d = src[j]
                if d == '\\':
                    j += 2; continue
                if d == '\n':
                    break                        # a regex cannot span a line: that was a division
                if cls:
                    if d == ']':
                        cls = False
                    j += 1; continue
                if d == '[':
                    cls = True; j += 1; continue
                if d == '/':
                    ok = True; break
                j += 1
            if ok:
                while j + 1 < n and src[j + 1].isalpha():
                    j += 1                       # the flags
                out.append(src[i:j + 1]); prev = '/'; i = j + 1; continue
        if c == '/' and i + 1 < n and src[i + 1] == '/':
            j = src.find('\n', i)
            j = n if j < 0 else j
            out.append(blank(src[i:j])); i = j; continue        # a comment: `prev` stands
        if c == '/' and i + 1 < n and src[i + 1] == '*':
            j = src.find('*/', i + 2)
            j = n if j < 0 else j + 2
            out.append(blank(src[i:j])); i = j; continue
        if c in '"\'':
            j = i + 1
            while j < n and src[j] != c and src[j] != '\n':
                j += 2 if src[j] == '\\' else 1
            j = min(j + 1, n)
            out.append(blank(src[i:j])); prev = c; i = j; continue
        if c == '`':
            out.append(' ')
            j = i + 1
            while j < n:
                if src[j] == '\\':
                    out.append('  '); j += 2; continue
                if src[j] == '$' and j + 1 < n and src[j + 1] == '{':
                    k, depth = j + 2, 1
                    while k < n and depth:
                        if src[k] == '{':
                            depth += 1
                        elif src[k] == '}':
                            depth -= 1
                        k += 1
                    out.append('  ' + src[j + 2:k]); j = k; continue
                if src[j] == '`':
                    out.append(' '); j += 1; break
                out.append('\n' if src[j] == '\n' else ' '); j += 1
            prev = '`'; i = j; continue
        # **The last significant character, and it was never recorded.** Without this `prev` stayed
        # empty for the whole file, so *every* `/` looked like the start of a regex - the widening
        # that was meant to read two of them read hundreds, and each ran to the next slash on its
        # line, taking a quote with it. Twenty-two lines of `export.js` came out different from the
        # JavaScript twin, which is how it was found: the two scanners are compared, not trusted.
        if not c.isspace():
            prev = c
        out.append(c); i += 1
    return ''.join(out)


class ExportReadsNothingLate(unittest.TestCase):
    """The export builds its report from an operation, so nothing in it may come from the panel.

    `apps/crm/export.js` has no module state of its own - one `const` of CSS and nothing else - and
    every value it uses arrives through `beginWorkspaceOp()`, which carries the folder, the
    generation and a guard on every read and write. One value did not: the report's own file name was
    built from `bound`, the panel's binding, read after all the awaits.

    That is not caught by `op.write`. `bound` is reassigned by a pull and by a rebinding of the Zoho
    tab, and neither of those moves the workspace - so the folder and the generation still match, the
    write is allowed, and the file is named for one org while its contents mirror another. A report
    that misnames the org it describes is the one thing this product may not produce.

    **The limit, stated:** this reads `apps/crm/export.js` only, because it is the one shipped file
    here that is a pure consumer of an operation and owns no state. The panels legitimately read
    their own globals after an await, guarded by `current()`, and telling those apart needs a parser.
    """

    def names(self):
        """The panel's *mutable* module state, and only that.

        `asynccheck.globals_of` was tried first and answers a different question - it is built for the
        write check, so it hands back every top-level name including `MSG`, `setStatus` and `null`.
        Reading a constant or a function after an await is not this defect; reading something that can
        be reassigned under you is. So: top-level `let` and `var`, which is what «can change while you
        are awaiting» means in this file. The limit is that a declaration wrapped across lines is not
        seen - there are none in either panel today, and one added tomorrow is invisible here rather
        than wrong.
        """
        import importlib.util
        spec = importlib.util.spec_from_file_location('ac_for_export', ROOT / 'tools' / 'asynccheck.py')
        ac = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(ac)
        src = (ROOT / 'apps' / 'crm' / 'sidepanel.js').read_text(encoding='utf-8')
        names = set()
        # A trailing comment is part of the line, and `;\s*$` does not allow one. Measured when a
        # later check needed the same list: `sidepanel.js` has **8** such declarations and
        # `graphview.js` **14**, `erCut` and `erPrintFull` among them - names that were invisible to
        # every derivation built on this pattern, including this one, on the day it was written.
        for m in re.finditer(r'^(?:let|var)\s+(.+?);[ \t]*(?://.*)?$', src, re.M):
            for part in m.group(1).split(','):
                n = part.strip().split('=')[0].strip()
                if re.fullmatch(r'[A-Za-z_$][\w$]*', n):
                    names.add(n)
        self.assertGreater(len(names), 20, 'the panel\'s module state was not found at all - the '
                                           'declarations moved and this test now proves nothing')
        return ac, sorted(names)

    def late_reads(self, source):
        ac, names = self.names()
        code = _code_only(source)
        found = []
        for name, body, _start in ac.functions(source):
            at = source.find(body)
            blanked = code[at:at + len(body)]
            first = blanked.find('await ')
            if first < 0:
                continue
            for g in names:
                for m in re.finditer(r'(?<![\w$.])' + re.escape(g) + r'(?![\w$])', blanked[first:]):
                    line = code[:at + first + m.start()].count('\n') + 1
                    found.append((line, name, g))
        return sorted(set(found))

    def test_nothing_in_the_export_is_read_from_the_panel_after_an_await(self):
        src = (ROOT / 'apps' / 'crm' / 'export.js').read_text(encoding='utf-8')
        late = self.late_reads(src)
        self.assertEqual(late, [], 'the export takes these from the panel after an await, so they '
                                   'describe whatever the panel had become by then, not the workspace '
                                   'being written: ' + ', '.join(f'{n}() reads {g} at line {ln}' for ln, n, g in late))

    def test_it_sees_the_read_that_was_there(self):
        # The defect itself, restored in a copy: the file name built from `bound` inside a template
        # literal, after every await. A scan that blanks template literals whole reports zero here.
        src = (ROOT / 'apps' / 'crm' / 'export.js').read_text(encoding='utf-8')
        planted = src.replace('const name = `export/zoost-${sanitize(whose)}-${stamp}.md`;',
                              "const name = `export/zoost-${sanitize((bound && bound.instance) || 'workspace')}-${stamp}.md`;")
        self.assertNotEqual(planted, src, 'the export no longer builds its name where this test plants')
        late = self.late_reads(planted)
        self.assertTrue(any(g == 'bound' for _, _, g in late),
                        'the plant was not seen - most likely the template literal is being blanked whole')


class AsyncCheckSaysWhatItDoesNotRead(unittest.TestCase):
    """The await count in the headline is the awaits it *entered*, not the ones in the file.

    It printed «942 await(s) read» and counted every `await` token in its subject files. The tool
    reads function *declarations*, so an `await` inside an async IIFE, or inside
    `$('save').onclick = async () => {...}`, was counted as read and never looked at. Measured: 960
    in the files, 837 inside a scope it enters.

    That is the class this repository already met in `htmlcheck` - a headline counting what was
    opened and saying nothing about what was examined inside - in the tool built to answer it. The
    surface it cost most was the diagram window: 10 of `graphview.js`'s 12 awaits are in those two
    shapes, so «0 findings» there was a statement about two lines.

    Printed rather than raised, because widening to arrow bodies needs a parser this repository does
    not have and this file has twice made that widening wrong. What is refused is the silence.
    """

    def run_it(self, *args):
        return subprocess.run([sys.executable, str(ROOT / 'tools' / 'asynccheck.py'), *args],
                              cwd=ROOT, capture_output=True, text=True)

    def numbers(self, out):
        m = re.search(r'(\d+) await\(s\) inside a scope this reads, (\d+) NOT read', out)
        self.assertIsNotNone(m, f'the headline no longer says how much of its subject it entered:\n{out}')
        return int(m.group(1)), int(m.group(2))

    def test_the_headline_separates_entered_from_present(self):
        out = self.run_it().stdout
        seen, unseen = self.numbers(out)
        self.assertGreater(seen, 500, 'the tool reads almost nothing - the derivation broke')
        # **It is zero now, and that is a fact rather than a silence.** This used to require the
        # number to be *above* zero, because reporting none was the false claim it replaced - and it
        # said so in its own message: if the gap is ever really closed, change this. It is closed:
        # every async scope in the tree is a named declaration, so there is nothing outside one to
        # read. What proves the counter still works is the case below, which plants the shape and
        # requires the number to move - a zero that cannot rise would be the same silence again.
        self.assertEqual(unseen, 0,
                         f'{unseen} await(s) are outside every declaration. The convention is that '
                         'every async scope is one, so this is either a new scope written the old '
                         'way or a shape the reader has stopped recognising:\n' + out)

    def test_an_await_outside_a_declaration_is_counted_as_unread(self):
        # Run it, on a real file. The plant *writes* the shape the tool cannot enter rather than
        # editing one that happens to be there: the first version inserted an await into an existing
        # `$('saveScope').onclick = async () => {`, and the day that handler became a named
        # declaration the replace matched nothing, the numbers did not move, and the case failed
        # saying the tool had stopped counting. It had not - the fixture had. **A plant that names a
        # site is a fixture with an expiry date**; plant the shape.
        f = ROOT / 'apps' / 'crm' / 'options.js'
        keep = f.read_text(encoding='utf-8')
        before = self.numbers(self.run_it().stdout)
        try:
            f.write_text(keep + "\n$('planted').onclick = async () => { await 0; };\n",
                         encoding='utf-8')
            seen, unseen = self.numbers(self.run_it().stdout)
        finally:
            f.write_text(keep, encoding='utf-8')
        self.assertEqual(seen, before[0], 'an await the tool cannot enter was counted as entered')
        self.assertEqual(unseen, before[1] + 1, 'an await outside every declaration was not counted at all')

    def test_an_await_inside_a_declaration_is_counted_as_read(self):
        # The other half, and the one that makes the first mean something: a gate that counts
        # everything as unread would pass the test above and be useless.
        f = ROOT / 'apps' / 'crm' / 'options.js'
        keep = f.read_text(encoding='utf-8')
        before = self.numbers(self.run_it().stdout)
        try:
            f.write_text(keep.replace('async function saveKeys(obj) {',
                                      'async function saveKeys(obj) { await 0;', 1),
                         encoding='utf-8')
            seen, unseen = self.numbers(self.run_it().stdout)
        finally:
            f.write_text(keep, encoding='utf-8')
        self.assertEqual(seen, before[0] + 1, 'an await inside a declaration was not counted as read')
        self.assertEqual(unseen, before[1], 'an await the tool does enter was reported as unread')


class EveryLedgerKeepsWhatAPersonWrote(unittest.TestCase):
    """A ledger invites an explanation and must not throw it away.

    Every one of these files says some version of «being here means somebody read it and decided it
    is safe», which is an invitation to write down *why*. `--accept` then regenerates the file whole:
    the tool writes its own header and the entries, and anything else is gone without a word.

    `keep_comments` was written for exactly this, after `tools/asyncglobals.txt` came within one run
    of losing nineteen hand-written lines. It reached three of the five writers. Measured by putting
    a comment into `cssdupes.txt` and `notenglish.txt` and running `--accept`: both deleted it, and
    the battery stayed green. `absolutes.txt` was worse - 1,142 lines and **no header at all**, so
    nothing said where it came from or that editing it by hand is pointless.

    Derived: every `tools/*.txt` here is a ledger, the tool that owns it is read out of its own first
    lines, and each is driven for real - a comment planted, `--accept` run, the file restored. A
    ledger added tomorrow is covered without anybody remembering.

    **The limit, stated:** a ledger whose header does not name its tool cannot be driven and is
    reported as such rather than skipped, because «no owner» is the finding, not an exemption.
    """

    LEDGERS = sorted((ROOT / 'tools').glob('*.txt'))

    def test_there_are_ledgers_to_check(self):
        self.assertGreaterEqual(len(self.LEDGERS), 5,
                                'no ledgers found in tools/ - the derivation broke')

    def test_each_names_the_tool_that_writes_it(self):
        for led in self.LEDGERS:
            head = '\n'.join(led.read_text(encoding='utf-8').split('\n')[:8])
            self.assertRegex(head, r'tools/\w+\.py',
                             f'{led.name}: nothing in it says which tool derives it, so a reader '
                             f'cannot tell an edit by hand is about to be overwritten')

    def test_a_comment_a_person_wrote_survives_accept(self):
        for led in self.LEDGERS:
            keep = led.read_text(encoding='utf-8')
            head = '\n'.join(keep.split('\n')[:8])
            m = re.search(r'tools/(\w+)\.py', head)
            self.assertIsNotNone(m, f'{led.name}: no owning tool named')
            tool = ROOT / 'tools' / f'{m.group(1)}.py'
            self.assertTrue(tool.exists(), f'{led.name} names {tool.name}, which is not here')

            mark = '# PLANTED by tests/tools_test.py: a reason a person wrote.'
            try:
                lines = keep.split('\n')
                lines.insert(1, mark)
                led.write_text('\n'.join(lines), encoding='utf-8')
                # `--offline` for the one that would otherwise reach the network; harmless elsewhere,
                # since an unknown flag is refused and the assertion below then names the tool.
                args = [sys.executable, str(tool), '--accept']
                if tool.name == 'auditcheck.py':
                    args.insert(2, '--offline')
                r = subprocess.run(args, cwd=ROOT, capture_output=True, text=True)
                after = led.read_text(encoding='utf-8')
            finally:
                led.write_text(keep, encoding='utf-8')
            self.assertIn(mark, after,
                          f'{led.name}: {tool.name} --accept deleted a line a person wrote, without '
                          f'saying so. The file asks to be explained and then throws the explanation '
                          f'away.\n{r.stdout[-400:]}{r.stderr[-400:]}')


class TheProbeSaysHowMuchOfItIsGuessing(unittest.TestCase):
    """A sleep is a bet about how long the panel takes; a condition is a measurement.

    `tools/probe.py` drove the panel with 86 fixed sleeps - a click, a wait of 300 to 1500ms, then a
    read of the state that click was supposed to produce. That is the shape this repository has
    already written down and condemned in `CLAUDE.md`: «read scrollTop after a second is the 1990s
    junior's sleep, and it produces a fix of the same shape - one that waits instead of knowing». It
    was living in the tool built to catch that class, and nothing said so.

    Two costs, and the second is the one that matters. A bet that wins costs its whole number on
    every run - roughly fifty seconds of the probe is sleeping. A bet that loses reads unsettled
    state, and the failure lands three lines later about something else, which is what «flaky» is.

    **They were 86 and they are 10, five of which are the polling step inside `until` itself.** The
    conversion was not done by naming a condition 76 times - it was done by naming the one condition
    they all shared: `settle()` watches the document and returns as soon as it has been quiet for a
    moment, so «the panel has finished drawing» is asked rather than guessed. A click followed by a
    sleep followed by a read was the shape in every one of them.

    What `settle` does not cover is stated where it is defined: work that finishes without touching
    the DOM. Those five are what is left, and the number below holds them. It moves in either
    direction only deliberately - a run that converts one must lower it in the same change, which is
    what stops a ledger that «may only shrink» from quietly stopping measuring anything. That
    absolute was stated eleven times in this repository and measured false; this one says which way
    it moved and why.
    """

    CEILING = 10

    def waits(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('probe_waits', ROOT / 'tools' / 'probe.py')
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod.waits()

    def test_the_bare_sleeps_may_only_shrink(self):
        bare, cond = self.waits()
        self.assertGreater(cond, 0, 'no condition wait is used at all - `until` exists and nothing calls it')
        self.assertLessEqual(bare, self.CEILING,
                             f'{bare} bare sleeps, up from {self.CEILING}. A new one is a new bet '
                             f'about how long the panel takes - use `until(cond, what)`, which says '
                             f'which condition never came true instead of failing later about '
                             f'something else. If a sleep is genuinely the only option, lower this '
                             f'ceiling deliberately and say why in the commit.')
        if bare < self.CEILING:
            self.fail(f'{bare} bare sleeps, down from {self.CEILING} - lower CEILING to {bare} in '
                      f'the same change, or the ledger stops measuring anything')

    def test_the_run_says_both_numbers(self):
        # Read off the source rather than by running it: the probe needs Chrome and the sentence is
        # what this is about. What it must not be is a number typed beside the code - the counter is
        # derived from the scenarios, and this checks the sentence uses it.
        src = (ROOT / 'tools' / 'probe.py').read_text(encoding='utf-8')
        self.assertIn('bare, cond = waits()', src,
                      'the run no longer prints how much of the probe is guessing')
        self.assertRegex(src, r'\{cond\} of \{bare \+ cond\} waits are for a condition',
                         'the printed sentence does not carry both counts')

    def test_the_counter_reads_the_scenarios_and_not_its_own_prose(self):
        # It did read its own prose: a quoted example inside the helper's comment counted as a fifth
        # bet in every scenario, which is the defect this repository has met three times in checkers.
        # Derived by planting the phrase in a comment *outside* any scenario and watching the count
        # stay put.
        src = (ROOT / 'tools' / 'probe.py')
        keep = src.read_text(encoding='utf-8')
        before = self.waits()
        try:
            src.write_text(keep.replace('def waits() -> tuple:',
                                        '# await wait(999) await until(x)\ndef waits() -> tuple:', 1),
                           encoding='utf-8')
            after = self.waits()
        finally:
            src.write_text(keep, encoding='utf-8')
        self.assertEqual(after, before,
                         'the counter counts prose about waiting as waiting, so its number says '
                         'nothing about what the probe actually does')

    def probe(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('probe_ready', ROOT / 'tools' / 'probe.py')
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    def test_every_scenario_refuses_a_click_on_a_hidden_control(self):
        """A click on a control the product hides neither throws nor works.

        The worst shape a step in a driver can have, and the ER scenario had it: it opened by
        clicking the diagram tab, which carries `display:none` until the graph arrives. Early, the
        click did nothing, `settle` returned on a document quiet for its own reasons, and the run
        failed three lines later saying «the fixture draws 0 boxes» - which reads as a bad fixture.
        It passed whenever the browser was already warm, and that was the whole of «intermittent».

        **The check for it was a text sweep and could not see it.** Of the 75 clicks in these
        scenarios it reached 40 and could judge 2 - the click goes through a helper, and «a wait
        exists somewhere earlier» is true of everything after the first one - so deleting the guard
        it was written for changed its answer not at all. Text cannot answer «is this on screen».
        The page can, and every scenario now installs a `click` that refuses one the product is
        hiding. It found two real defects on its first run, one of them in the product.

        What is held here is the one thing a text scan can honestly hold: that the guard is there.
        """
        missing, scenarios = self.probe().click_guard_installed()
        self.assertGreater(scenarios, 3, 'no scenario was read - the denominator is empty')
        self.assertEqual(missing, [],
                         f'{missing} drive the panel without refusing a click on a hidden control, so '
                         f'a click that does nothing there fails later, about something else')

    def test_it_can_see_a_scenario_without_the_guard(self):
        # A clean answer proves nothing until the subject is made dirty on purpose.
        src = ROOT / 'tools' / 'probe.py'
        keep = src.read_text(encoding='utf-8')
        old = '    HTMLElement.prototype.click = function clickOnScreen() {'
        self.assertIn(old, keep, 'the scenarios no longer install the guard the way this plant expects')
        try:
            # The install taken out, not the word: blanking `const real = …` left the marker behind
            # and this passed, which is the check measuring a mention instead of the act.
            src.write_text(keep.replace(old, '    const unusedGuard = function clickOnScreen() {', 1), encoding='utf-8')
            missing, _ = self.probe().click_guard_installed()
        finally:
            src.write_text(keep, encoding='utf-8')
        self.assertTrue(missing,
                        'a scenario with the guard taken out was not reported, so the clean answer '
                        'above is a clean answer about nothing')


class WhatTheAssistantSendsIsDeclared(unittest.TestCase):
    """The privacy page enumerates, and an enumeration kept by hand is one that drifts.

    Section 4.2 listed the categories from memory. Analytics was sending the folder a view sits in,
    its description, the two dates Zoho records against it and - the one that matters - the name
    Zoho keeps as its owner, which is a person, while the page said «view names, column names and
    data types, the relations, the dependency graph and the SQL». The CRM was sending the values
    inside a picklist, which are the reader's own vocabulary and not Zoho's, and the scopes granted
    to each connection. Nobody was wrong on the day it was written; the code moved and the sentence
    did not.

    `tools/aidatacheck.py` derives the fields from the answer builders and `tools/aisends.txt` says
    where each is declared on the page. Its limits are in its docstring rather than here.
    """

    def check(self, argv=()):
        import importlib.util
        spec = importlib.util.spec_from_file_location('aidata', ROOT / 'tools' / 'aidatacheck.py')
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    def test_every_field_the_assistant_sends_has_a_row(self):
        mod = self.check()
        sent = {(app, k) for app, ks in mod.sent().items() for k in ks}
        self.assertGreater(len(sent), 20,
                           'the scan found almost nothing - the answer builders have moved and this '
                           'is passing over an empty set')
        missing = sorted(sent - set(mod.ledger()))
        self.assertEqual(missing, [], f'sent and undeclared: {missing}')

    def test_a_row_for_something_nothing_sends_is_a_finding(self):
        # A policy that over-declares describes a product that does not exist, which is its own kind
        # of wrong. Planted, because a clean answer proves nothing until the subject is made dirty.
        led = ROOT / 'tools' / 'aisends.txt'
        keep = led.read_text(encoding='utf-8')
        try:
            led.write_text(keep + 'crm\tsecret_token\tnothing sends this\n', encoding='utf-8')
            mod = self.check()
            sent = {(app, k) for app, ks in mod.sent().items() for k in ks}
            self.assertIn(('crm', 'secret_token'), set(mod.ledger()) - sent,
                          'a ledger row for a field nothing emits is not reported')
        finally:
            led.write_text(keep, encoding='utf-8')

    def test_it_reads_fields_and_not_prose(self):
        # It did read prose: «in the 24 hours before that: ${n}» and «Total in workspace: ${n}» went
        # into the ledger as fields of the answer. A checker inventing subjects is the class this
        # repository catches by measuring its own tools.
        mod = self.check()
        sent = {k for ks in mod.sent().values() for k in ks}
        for word in ('that', 'workspace'):
            self.assertNotIn(word, sent,
                             f'«{word}» is a word in a sentence, not a field of an answer - the '
                             f'pattern has stopped anchoring to the start of a line')


class NobodyParksACase(unittest.TestCase):
    """A case switched off in the source is a case nobody runs, and both counts hide it.

    `test('x', { skip: … })` still appears in node's `tests N`, and `@unittest.skip` leaves «Ran N»
    where it was and prints `OK (skipped=1)` underneath - so the exact numbers in `tests/run.sh`,
    which exist to notice cases that stop running, cannot see the commonest way one does.

    Refusing every skip was tried and was wrong: two cases skip on GitHub's runner - no Chrome, a
    shallow clone - and turning those red made a correct run fail. That is the honest answer to «the
    browser is what this asserts about and there is no browser», and it is what the runner needs.

    The line is between the two. An environment gate is decided *at run time*, carries its reason,
    and is `self.skipTest(...)`; a parked case is decided in the source and is a decorator or an
    option. This holds the second one, which is the one nobody can see in a count.
    """

    def test_no_python_case_is_parked_in_the_source(self):
        for f in sorted((ROOT / 'tests').glob('*.py')):
            src = f.read_text(encoding='utf-8')
            for m in re.finditer(r'(?m)^\s*@unittest\.(skip|expectedFailure)\b.*$', src):
                line = src[:m.start()].count('\n') + 1
                self.fail(f'{f.name}:{line} parks a case in the source: {m.group(0).strip()[:70]}. '
                          f'It is counted as run by tests/run.sh and executed by nothing. An '
                          f'environment gate belongs at run time, as self.skipTest(reason).')

    def test_no_node_case_is_parked_in_the_source(self):
        for f in sorted((ROOT / 'tests').glob('*.test.mjs')):
            src = f.read_text(encoding='utf-8')
            for m in re.finditer(r'(?m)^\s*(?:test|it)\([^\n]*\{\s*(skip|todo)\s*:', src):
                line = src[:m.start()].count('\n') + 1
                self.fail(f'{f.name}:{line} parks a case: {m.group(0).strip()[:70]}. Node counts it in '
                          f'«tests N», so the exact number in tests/run.sh cannot notice it.')

    def test_every_runtime_skip_says_why(self):
        # The other half: a gate with no reason is indistinguishable from a park, in the one place a
        # reader looks when a count is lower than they expected.
        # Lines that *are* the call, not lines that mention it: the first version matched the word
        # inside this class's own failure message and reported itself - a checker reading its own
        # prose, which this repository has now met four times in one day.
        for f in sorted((ROOT / 'tests').glob('*.py')):
            for line in f.read_text(encoding='utf-8').split('\n'):
                m = re.match(r'\s*(?:self\.)?skipTest\(\s*(.)', line)
                if not m:
                    continue
                self.assertIn(m.group(1), '\'"',
                              f'{f.name}: a skipTest with no written reason - «{line.strip()[:60]}»')


class TheRawObjectRuleCanProduceAPositive(unittest.TestCase):
    """`raw_objects()` had no test at all, and the two plants in the commit that added it were both
    on the *field* scan beside it. A sweep asked to break it walked seven handover forms past it -
    every one of them something somebody writes - and made it report a refactor that changes nothing.

    So the forms are the cases. Each is substituted into a shipped answer builder, the checker is run,
    and the exit code is read; the file is restored either way.
    """

    ANCHOR = 'aiTrunc(JSON.stringify(workflowForModel(detail || e), null, 2), 6000))'
    LEAKS = ['JSON.stringify(e.detail, null, 2)',
             'JSON.stringify(rows[0], null, 2)',
             'JSON.stringify(list.filter((x) => x.path === p), null, 2)',
             'JSON.stringify(Object.assign({}, e), null, 2)',
             'JSON.stringify([e], null, 2)',
             'JSON.stringify({ ok: 1, ...e }, null, 2)',
             'JSON.stringify({ ...e, kind: 1 }, null, 2)',
             'JSON.stringify(e ?? {}, null, 2)']

    def run_check(self):
        return subprocess.run([sys.executable, str(ROOT / 'tools' / 'aidatacheck.py')],
                              cwd=ROOT, capture_output=True, text=True)

    def plant(self, replacement, extra=None):
        src = ROOT / 'apps' / 'crm' / 'ai.js'
        keep = src.read_text(encoding='utf-8')
        self.assertIn(self.ANCHOR, keep, 'the workflow branch has moved - these plants have no subject')
        try:
            body = keep.replace(self.ANCHOR, replacement, 1)
            if extra:
                body = body.replace(extra[0], extra[1], 1)
            src.write_text(body, encoding='utf-8')
            return self.run_check()
        finally:
            src.write_text(keep, encoding='utf-8')

    def test_it_is_clean_on_the_tree_as_it_stands(self):
        r = self.run_check()
        self.assertEqual(r.returncode, 0, r.stdout)

    def test_every_handover_form_is_reported(self):
        for form in self.LEAKS:
            with self.subTest(form=form):
                r = self.plant(f'aiTrunc({form}, 6000))')
                self.assertEqual(r.returncode, 1,
                                 f'«{form}» hands a stored row to the provider and the checker said '
                                 f'nothing:\n{r.stdout}')

    def test_a_projection_hoisted_into_a_local_is_not_a_finding(self):
        # The one refactor that changes nothing, and the first version reported it. A local counts as
        # projected when its own initialiser is a projection call.
        r = self.plant('aiTrunc(JSON.stringify(safe, null, 2), 6000))',
                       ('      if (detail || e) {',
                        '      const safe = workflowForModel(detail || e);\n      if (detail || e) {'))
        self.assertEqual(r.returncode, 0,
                         f'hoisting the projection into a local is reported as a leak:\n{r.stdout}')

    def test_the_run_says_how_many_builders_gave_it_nothing(self):
        # The headline counted the names typed into SOURCES - it would have printed seven with all
        # seven deleted from the source. Five of the seven contribute no field, and the run says so.
        r = self.run_check()
        self.assertRegex(r.stdout, r'read from \d+ of \d+ answer builder',
                         'the headline no longer separates what was read from what was opened')
        self.assertIn('no field has the', r.stdout,
                      'the builders that contribute nothing are not named, so five empty subjects '
                      'hide inside one number')


class BothListingsHaveTheSameShape(unittest.TestCase):
    """Two listings, one submission process: a section in one is a section in the other.

    The store copy is enumerated in ten numbered sections and both products are published from that
    file. A section present in one and absent from the other is either a field that will be pasted
    from nothing, or a permission one product asks for and never justifies - and Google reviews the
    two together.

    Nothing compared them. Measured by deleting §8 from the CRM listing: `sitecheck` printed «6 of 9
    numbered sections measured» directly under «7 of 10» for Analytics and called neither a finding,
    and the only red came from five `dashcheck` fixture tests **crashing** - an error, not a
    statement, whose message says nothing about two listings disagreeing. A defect noticed as a
    stack trace in an unrelated builder is a defect nobody will diagnose.

    Derived from the headings, so a section added tomorrow is compared without anybody remembering.

    **The limits, stated.** It compares the numbered headings and the *titles* they carry, not the
    prose under them - two products legitimately say different things there, which is what
    `storecopy` and `dashcheck` are for. And an unnumbered heading (the notes at the end) is out of
    scope, because it is not a dashboard field.
    """

    def sections(self, app):
        text = (ROOT / 'store' / app / 'store-listing.md').read_text(encoding='utf-8')
        out = {}
        for m in re.finditer(r'^## (\d+)\. (.+?)\s*$', text, re.M):
            out[int(m.group(1))] = m.group(2)
        return out

    def apps(self):
        return sorted(p.name for p in (ROOT / 'store').iterdir()
                      if (p / 'store-listing.md').exists() and p.name != 'x')

    def test_there_are_two_listings_to_compare(self):
        self.assertGreaterEqual(len(self.apps()), 2,
                                'fewer than two listings found - the derivation broke')

    def test_the_same_numbered_sections_exist_in_both(self):
        got = {app: self.sections(app) for app in self.apps()}
        for app, secs in got.items():
            self.assertGreaterEqual(len(secs), 8, f'{app}: only {len(secs)} numbered section(s) read')
        every = set().union(*got.values())
        for app, secs in got.items():
            missing = sorted(every - set(secs))
            self.assertEqual(missing, [],
                             f'{app}/store-listing.md has no section {missing} and the other listing '
                             f'does - either a dashboard field that would be pasted from nothing, or '
                             f'a permission asked for and never justified. Google reviews them together.')

    def test_a_section_number_means_the_same_thing_in_both(self):
        # The numbers are how a person finds the field in the dashboard, so §7 naming one thing here
        # and another there is worse than a gap: it reads as correct and is pasted into the wrong box.
        got = {app: self.sections(app) for app in self.apps()}
        first, *rest = self.apps()
        for app in rest:
            for n, title in got[first].items():
                if n not in got[app]:
                    continue
                self.assertEqual(got[app][n], title,
                                 f'§{n} is «{title}» in {first} and «{got[app][n]}» in {app} - the '
                                 f'number is how the field is found in the dashboard')


class TheProductsOwnProseIsRead(unittest.TestCase):
    """An absolute inside the extension is where an absolute costs most.

    `CLAUDE.md` draws the line itself: the site is informational and a wrong number there harms
    nobody, while the extension is where somebody *acts* on what it says. `auditcheck` read the site,
    the README, the store listings and `docs/boundaries.md` - and not one line of the panel or the
    Settings page, for the length of the project. Measured by planting «Your API key never leaves
    this machine.» in `apps/crm/options.html`: the whole battery passed, and the only thing that
    moved was `imgcheck`, because the file's digest changed.

    The first sweep of the widened subject found one real claim: «Whatever is left out is named as
    left out, so the assistant never assumes something is absent because it was not shown one» - a
    guarantee about what a language model will conclude, in both products. Corrected to say what
    Zoost does.

    Derived: every page that ships is inside the subject, taken from the manifests' own file list
    rather than from a pattern typed here, so a page added tomorrow cannot be outside it quietly.

    **The limit, stated:** this covers markup. Prose built in a script - the panel's `MSG` table and
    every status line - is *not* read by `auditcheck`, and that is the larger half by volume. Said
    here rather than left as a silence; widening to it means teaching `sentences()` to read a string
    table, which is a change to what a sentence *is* and not a pattern.
    """

    def subject(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('ac_outward', ROOT / 'tools' / 'auditcheck.py')
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        seen = set()
        for pattern in mod.OUTWARD:
            for p in ROOT.glob(pattern):
                seen.add(p.relative_to(ROOT).as_posix())
        return seen

    def shipped_pages(self):
        out = set()
        for man in sorted((ROOT / 'apps').glob('*/manifest.json')):
            app = man.parent
            for p in sorted(app.glob('*.html')):
                out.add(p.relative_to(ROOT).as_posix())
        return out

    def test_there_are_pages_to_read(self):
        self.assertGreaterEqual(len(self.shipped_pages()), 4,
                                'no shipped pages found - the derivation broke')

    def test_every_shipped_page_is_in_the_subject(self):
        missing = sorted(self.shipped_pages() - self.subject())
        self.assertEqual(missing, [],
                         f'these ship and a reader reads them, and no absolute in them is ever '
                         f'recorded or questioned: {missing}')

    def test_a_new_absolute_in_a_shipped_page_is_a_finding(self):
        # Run it: the plant that went through the whole battery before this existed.
        page = ROOT / 'apps' / 'crm' / 'options.html'
        keep = page.read_text(encoding='utf-8')
        try:
            page.write_text(keep.replace('</body>',
                                         '  <p>Your API key never leaves this machine.</p>\n</body>', 1),
                            encoding='utf-8')
            out = subprocess.run([sys.executable, str(ROOT / 'tools' / 'auditcheck.py'), '--offline'],
                                 cwd=ROOT, capture_output=True, text=True)
        finally:
            page.write_text(keep, encoding='utf-8')
        self.assertIn('never leaves this machine', out.stdout,
                      f'an absolute added to the Settings page is not reported:\n{out.stdout[-600:]}')


class WhatTheProductSaysIsRead(unittest.TestCase):
    """A shipped script's `MSG` table is prose a reader reaches, and it was the larger half.

    The previous widening put the shipped *markup* into `auditcheck`'s subject and wrote its own
    limit into the docstring: prose built in a script was still unread. Measured, that limit was the
    bigger part - a graph window's markup carries three sentences and its `MSG` table forty-three.
    An absolute planted in that table («Every box in this diagram is always drawn.») was reported by
    nothing, because the tool never opened a `.js` file.

    The table is the boundary rather than every string literal: a selector, a class name and a URL
    are all strings and none of them is prose. `MSG` exists because this project already decided that
    what the product says lives in one place, and `tests/panel.test.mjs` holds every shipped script
    to it - so the boundary is a decision already made, read rather than restated here.

    **The limits, stated.** A value that is a *function* - a sentence assembled at run time out of
    numbers - is skipped, because its fixed parts say nothing on their own. And a script with no
    `MSG` table contributes nothing, which is correct today and would hide a second table introduced
    under another name.
    """

    def subject(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('ac_msg', ROOT / 'tools' / 'auditcheck.py')
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    def scripts_with_a_table(self):
        return sorted(p for p in (ROOT / 'apps').glob('*/*.js')
                      if re.search(r'^const MSG = \{$', p.read_text(encoding='utf-8'), re.M))

    def test_every_string_table_is_read(self):
        mod = self.subject()
        files = self.scripts_with_a_table()
        self.assertGreaterEqual(len(files), 4, 'no string tables found - the derivation broke')
        for f in files:
            got = mod.sentences(f)
            self.assertTrue(got, f'{f.relative_to(ROOT)} declares a MSG table and none of it is read')

    def test_each_message_is_its_own_key(self):
        # Joined into one stream, the sentence splitter glues label fragments together and editing
        # any one of them rewrites the whole run - the ledger churn this tool's own docstring records
        # about page chrome. Each value has to stand alone.
        mod = self.subject()
        got = mod.sentences(ROOT / 'apps' / 'crm' / 'graphview.js')
        self.assertGreater(len(got), 20, f'only {len(got)} message(s) read out of a table of forty-odd')
        longest = max(got, key=len)
        self.assertLess(len(longest), 400,
                        f'messages are being glued into runs, so one edit rewrites many keys: {longest[:120]}')

    def test_an_absolute_in_a_string_table_is_a_finding(self):
        # Run it: the plant that went through the whole battery before this existed.
        f = ROOT / 'apps' / 'crm' / 'graphview.js'
        keep = f.read_text(encoding='utf-8')
        try:
            f.write_text(keep.replace('const MSG = {',
                                      "const MSG = {\n  planted: 'Every box in this diagram is always drawn.',", 1),
                         encoding='utf-8')
            out = subprocess.run([sys.executable, str(ROOT / 'tools' / 'auditcheck.py'), '--offline'],
                                 cwd=ROOT, capture_output=True, text=True)
        finally:
            f.write_text(keep, encoding='utf-8')
        self.assertIn('always drawn', out.stdout,
                      f'an absolute added to what the product says is not reported:\n{out.stdout[-600:]}')

class TheCodeScannerReadsRegexLiterals(unittest.TestCase):
    """A regex literal is code, and a scanner that cannot see one swallows what follows it.

    `blankNonCode` in `tests/slice.mjs` said, in its own docstring, «regex literals... there is none
    in this repository - measured, not assumed». It had not been measured, and there are two:
    `apps/crm/export.js` holds ``.replace(/```/g, ...)`` - three backticks inside a regex - and
    `site/site.js` holds ``/`([^`]+)`/g``. Each opened a template literal the scanner then closed at
    the next backtick, taking whole functions with it: **68 code lines in `export.js` and 54 in
    `site.js`**. A check reading that text is a check with a hole in the middle of it, and
    `tests/panel.test.mjs`'s flag check reads exactly that text.

    The claim was the defect and the hole only its consequence, which is why this class exists rather
    than a wider line count: what has to hold is that a named declaration *after* a regex literal is
    still there.

    **And widening it made the hole bigger before it made it smaller.** The first version treated
    `/**` as a regex start, found the closing slash inside a path in the prose, and let the backtick
    after it open a template - 535 code lines lost in `sidepanel.js` alone, against the 2 the old
    scanner lost there. Only measuring caught that; reading it would not have.
    """

    def scan(self, rel):
        js = ("import { read, blankNonCode } from './tests/slice.mjs';"
              f"process.stdout.write(blankNonCode(read({rel!r})));")
        out = subprocess.run([shutil.which('node') or 'node', '--input-type=module', '-e', js],
                             cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stderr[-400:])
        return out.stdout

    def test_positions_are_preserved(self):
        # Everything below reads by line, and a scanner that shifts one is worse than none.
        for rel in ('apps/crm/export.js', 'site/site.js', 'apps/crm/sidepanel.js'):
            raw = (ROOT / rel).read_text(encoding='utf-8')
            self.assertEqual(len(self.scan(rel)), len(raw), f'{rel}: the scan changed the length')

    def test_a_declaration_after_a_regex_literal_survives(self):
        # Derived: every regex literal in the file, and the next top-level declaration after it. Both
        # files that carry one are read, and a third that does not is the control.
        for rel in ('apps/crm/export.js', 'site/site.js'):
            raw = (ROOT / rel).read_text(encoding='utf-8').split('\n')
            scanned = self.scan(rel).split('\n')
            marks = [i for i, l in enumerate(raw) if re.search(r'\.replace\(/', l) or re.search(r'= */[^/*]', l)]
            self.assertTrue(marks, f'{rel}: no regex literal found - the derivation broke')
            found = 0
            for at in marks:
                for i in range(at + 1, min(at + 40, len(raw))):
                    if re.match(r'^(const|let|function|async function) \w+', raw[i].strip()):
                        found += 1
                        self.assertTrue(scanned[i].strip(),
                                        f'{rel}:{i + 1} was swallowed by the regex literal at line {at + 1}: '
                                        f'{raw[i].strip()[:70]}')
                        break
            self.assertGreater(found, 0, f'{rel}: no declaration follows any regex literal')

    def test_the_two_scanners_agree_line_for_line(self):
        """One idea of what code is, in two languages, compared rather than trusted.

        `blankNonCode` (JavaScript) and `_code_only` (Python) do the same job for the checks written
        in each language, and they drifted the moment one of them learnt about regex literals: the
        Python copy never recorded the last significant character, so *every* `/` looked like a regex
        start and each ran to the next slash on its line. Twenty-two lines of `export.js` came out
        different, which is how it was found - by comparing them, not by reading either.

        Line by line and stripped, because trailing space is not a disagreement about code.
        """
        for rel in ('apps/crm/export.js', 'site/site.js', 'apps/crm/sidepanel.js',
                    'site/_worker.js', 'apps/analytics/graphview.js'):
            raw = (ROOT / rel).read_text(encoding='utf-8')
            py = _code_only(raw).split('\n')
            js = self.scan(rel).split('\n')
            self.assertEqual(len(py), len(js), f'{rel}: the two scanners disagree on the line count')
            bad = [i + 1 for i, (a, b) in enumerate(zip(py, js)) if a.strip() != b.strip()]
            self.assertEqual(bad, [], f'{rel}: the Python and JavaScript scanners disagree at lines '
                                      f'{bad[:8]} - one of them is reading something the other is not')

    def test_a_scanner_that_kept_everything_would_be_caught(self):
        # The other half. A scan that blanks nothing passes every assertion above, so the thing that
        # must also hold is that it still removes what it is for: no comment survives as text.
        scanned = self.scan('apps/crm/export.js')
        self.assertNotIn('export a self-contained, shareable HTML report', scanned,
                         'the scanner stopped removing comments, and the checks above would not know')


class TwinCheckOpensEveryPageBothProductsShip(unittest.TestCase):
    """«This compares the two side panels» was true, and read as the whole subject.

    Both products ship three pages. Two of them - `options.html` and `graphview.html` - were compared
    by nothing: 122 shared ids, against the 80 on the panel that were. Proven by giving the shared
    `#v-er` a different class *and* an inline style on the Analytics side only - twincheck 0
    findings, and htmlcheck, namecheck, featurecheck, csscheck and callcheck 0 as well. The same
    drift on `#pfoot` in `sidepanel.html` is two findings.

    Derived from the filenames, so a fourth page added to both products is compared without anybody
    remembering, and the run prints how many shared ids it read on each - which it did not before,
    and `tools/coverage.py` already named it as one of two checkers stating no work unit at all.

    **The limit, stated:** only tag, class and inline style. The CSS and the behaviour of these two
    pages genuinely diverge - the panels are one design and these are not - so comparing those would
    be a flood, and a flood is a check nobody reads.
    """

    def pairs(self):
        crm = {f.name for f in (ROOT / 'apps' / 'crm').glob('*.html')}
        an = {f.name for f in (ROOT / 'apps' / 'analytics').glob('*.html')}
        return sorted(crm & an)

    def run_it(self):
        return subprocess.run([sys.executable, str(ROOT / 'tools' / 'twincheck.py')],
                              cwd=ROOT, capture_output=True, text=True)

    def test_every_shared_page_is_opened(self):
        out = self.run_it().stdout
        for name in self.pairs():
            if name == 'sidepanel.html':
                self.assertIn('shared elements whose tag, class or inline style differs', out,
                              'the panel comparison is gone')
                continue
            self.assertRegex(out, rf'{re.escape(name)}: \d+ shared id\(s\) compared',
                             f'{name} ships in both products and the run says nothing about it')

    def test_it_says_how_much_it_read(self):
        # A count of what was inspected, which this tool printed for nobody: «0 undeclared
        # difference(s)» over two unopened pages reads exactly like «0» over three opened ones.
        out = self.run_it().stdout
        read = [int(m) for m in re.findall(r': (\d+) shared id\(s\) compared', out)]
        self.assertGreaterEqual(len(read), 2, f'only {len(read)} page(s) report a work unit:\n{out}')
        self.assertGreater(sum(read), 50, 'the pages are opened and almost nothing in them is read')

    def test_a_drift_on_one_of_those_pages_is_a_finding(self):
        # Run it, on the real file: the plant that went through every checker before this.
        page = ROOT / 'apps' / 'analytics' / 'graphview.html'
        keep = page.read_text(encoding='utf-8')
        try:
            page.write_text(keep.replace('<div class="view" id="v-er">',
                                         '<div class="view planted" id="v-er" style="outline:1px solid red">', 1),
                            encoding='utf-8')
            out = self.run_it()
        finally:
            page.write_text(keep, encoding='utf-8')
        self.assertNotEqual(out.returncode, 0, f'a drift on graphview.html passes:\n{out.stdout[-500:]}')
        self.assertIn('v-er', out.stdout, out.stdout[-500:])

class TheSiteNamesEveryAssistantTool(unittest.TestCase):
    """The tool list on `site/ai.html` is a hand-typed copy of a registry the code holds.

    Both products declare their tools in an `AI_TOOLS` array and the site prints them as a list of
    `<code>` chips. The CRM's had **nine of eleven**: `list_actions` and `list_failures` were added
    to the registry and not to the page, in both languages. The same defect was fixed *in the app*
    earlier the same day - the system prompt named ten of eleven, and the fix derived that sentence
    from the registry - and did not travel to the site, which is the enumeration trap running one
    surface over.

    Derived from the registry, per product, so a twelfth tool is a finding on the day it is written.

    **The limit, stated:** it reads the `<code>` chips inside `p.tools`, which is how that page marks
    a tool name. A tool named in the prose around it is neither found nor required.
    """

    def registry(self, app):
        src = (ROOT / 'apps' / app / ('ai.js' if app == 'crm' else 'sidepanel.js')).read_text(encoding='utf-8')
        at = src.index('AI_TOOLS')
        end = src.index('\n];', at)
        return sorted(set(re.findall(r"name: '(\w+)'", src[at:end])))

    def listed(self, rel):
        html = (ROOT / rel).read_text(encoding='utf-8')
        out = {}
        for m in re.finditer(r'<h3>([^<]*)</h3>\s*<p class="tools">(.*?)</p>', html, re.S):
            app = 'crm' if 'CRM' in m.group(1) else 'analytics' if 'Analytics' in m.group(1) else None
            if app:
                out[app] = sorted(set(re.findall(r'<code>(\w+)</code>', m.group(2))))
        return out

    def test_both_products_declare_tools(self):
        for app in ('crm', 'analytics'):
            self.assertGreaterEqual(len(self.registry(app)), 8,
                                    f'{app}: the registry was not read - the derivation broke')

    def test_every_page_lists_exactly_what_the_registry_holds(self):
        for rel in ('site/ai.html', 'site/it/ai.html'):
            listed = self.listed(rel)
            self.assertEqual(sorted(listed), ['analytics', 'crm'],
                             f'{rel}: the two tool lists were not found - the derivation broke')
            for app in ('crm', 'analytics'):
                have, said = self.registry(app), listed[app]
                self.assertEqual(said, have,
                                 f'{rel} names {len(said)} {app} tool(s) and the registry holds '
                                 f'{len(have)}: missing {sorted(set(have) - set(said))}, '
                                 f'invented {sorted(set(said) - set(have))}')

class ExamplesUseTheSampleWorkspaceNames(unittest.TestCase):
    """A module name in an example comes from the sample workspace, not from somewhere real.

    `CLAUDE.md` forbids the test environment showing through - «no real org, portal, instance,
    module, field, function or connection names», in code, comments, examples, tests and the site
    alike - and nothing checked it, because nothing here can know which names are real.

    Something *can* be checked: the project ships an invented org, `+ Sample` writes it, and every
    module a reader is shown could come from there. Four surfaces carried
    `getRelatedRecords("Tariffe_Prestazioni", "Professionisti", id)` - Italian module names in a
    clinical-practice shape, with `Prices_Services` / `Practitioners` as the English twin, which is
    the same domain translated rather than a different one. Found by an outside review, flagged as
    the class nothing here can verify; neutralised rather than argued about, since the placeholder
    costs nothing and the doubt does not.

    **The limit, and it is the whole of it:** this cannot tell a real name from an invented one. What
    it can do is hold the *examples* to the vocabulary the product itself ships, so a name from
    somewhere else has to be put there deliberately and will be visible when it is.
    """

    # The `zoho.crm.` prefix is **optional**, and requiring it was the first version's hole: the
    # guides write `getRelatedRecords("A", "B", id)` bare, so the four surfaces that carried the
    # names this class is about were not read at all. Caught by planting one back and watching the
    # check stay green - which is the reason every one of these gets a plant.
    CALLS = re.compile(r'(?:zoho\.crm\.)?(getRelatedRecords|getRecordById|updateRecord|createRecord|'
                       r'searchRecords|getRecords)\("([^"]+)"(?:,\s*"([^"]+)")?')

    def sample_names(self):
        src = (ROOT / 'apps' / 'crm' / 'sample-org.js').read_text(encoding='utf-8')
        names = set(re.findall(r"'([A-Z][A-Za-z_]{2,})'", src)) | set(re.findall(r'"([A-Z][A-Za-z_]{2,})"', src))
        self.assertGreater(len(names), 20, 'the sample workspace was not read - the derivation broke')
        return names

    def surfaces(self):
        out = [ROOT / 'site' / 'docs-crm.html', ROOT / 'site' / 'it' / 'docs-crm.html',
               ROOT / 'README.md']
        out += sorted((ROOT / 'apps' / 'crm').glob('*.js'))
        return out

    def test_every_module_named_in_an_example_is_one_the_sample_ships(self):
        known = self.sample_names()
        strangers, examples = [], 0
        for f in self.surfaces():
            for m in self.CALLS.finditer(f.read_text(encoding='utf-8')):
                examples += 1
                for name in (m.group(2), m.group(3)):
                    # A bare api_name only. The exports build these calls for the reader, so the
                    # argument is `${esc(r.api)}` or `<relation API name>` there - a placeholder is
                    # not a module name and reporting it would be the check misreading its subject.
                    if not name or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]*', name):
                        continue
                    if name not in known:
                        strangers.append(f'{f.relative_to(ROOT)}: {name} in {m.group(1)}(...)')
        self.assertGreater(examples, 3, f'only {examples} example call(s) found - the derivation broke')
        self.assertEqual(strangers, [],
                         'these examples name a module the sample workspace does not contain, so a '
                         'reader cannot tell an invented name from one that came from somewhere '
                         f'real: {strangers}')

class EveryTabIsNamedWhereItsSiblingsAre(unittest.TestCase):
    """A list of the panel's tabs is a list of the panel's tabs, wherever it is written.

    The CRM ships six: `functions, modules, workflows, schedules, actions, connections`, declared in
    `apps/crm/tabs.js`. **Actions** - a tab, a Pull-all runner, its own folder on disk, an export
    scope key, a node kind in the graph and an assistant tool - was named in six places and missing
    from fifteen, including `README.md`'s «Mode segments», both guides' «the mode segments switch
    what the tree lists», the quick start's Pull all, and the graph captions on three pages.

    This is the trap `CLAUDE.md` calls out by name: a part is listed in as many places as it has
    siblings, and adding it to one of them is not adding it. `featurecheck` cannot see it - it asks
    whether a control is named *somewhere* on the site, and Actions has a section of its own.

    Derived from the registry: **a passage that names four or more tabs in a row must name them
    all.** Four, not two, because a sentence about two tabs is a sentence about two tabs; an
    enumeration is what this is about.

    **The limits, stated.** It reads the tab *labels* as words, so a passage that refers to a tab by
    another name is invisible; and it looks inside one paragraph or list item at a time, so an
    enumeration split across two of them reads as two short ones. Both would need the passage
    rewritten to be caught, and neither is silent about itself.
    """

    def tabs(self):
        src = (ROOT / 'apps' / 'crm' / 'tabs.js').read_text(encoding='utf-8')
        labels = re.findall(r"label: '([^']+)'", src)
        self.assertGreaterEqual(len(labels), 5, 'the tab registry was not read - the derivation broke')
        return labels

    def surfaces(self):
        out = [ROOT / 'README.md']
        for d in (ROOT / 'site', ROOT / 'site' / 'it'):
            out += [f for f in sorted(d.glob('*.html')) if 'analytics' not in f.name]
        return out

    def test_no_passage_names_most_of_the_tabs_and_stops(self):
        labels = self.tabs()
        found, short = 0, []
        for f in self.surfaces():
            text = f.read_text(encoding='utf-8')
            # One paragraph, list item or alt text at a time - and for markdown, one **line**,
            # because it carries none of those tags and was therefore read as a single chunk that
            # names every tab somewhere. `README.md`'s «Mode segments» line was outside this check
            # entirely until the plant went green.
            parts = (text.split('\n') if f.suffix == '.md'
                     else re.split(r'</(?:p|li|h\d)>|">', text))
            for chunk in parts:
                plain = re.sub(r'<[^>]+>', ' ', chunk)
                named = [l for l in labels if re.search(rf'\b{re.escape(l)}\b', plain)]
                if len(named) < 4:
                    continue
                found += 1
                missing = [l for l in labels if l not in named]
                if missing:
                    short.append(f'{f.relative_to(ROOT)}: names {len(named)} of {len(labels)} tabs, '
                                 f'missing {missing} - "{" ".join(plain.split())[:90]}"')
        self.assertGreater(found, 3, f'only {found} enumeration(s) found - the derivation broke')
        self.assertEqual(short, [], 'these enumerate the panel\'s tabs and leave one out:\n  '
                                    + '\n  '.join(short))


class FigureCaptionsNameTheirOwnChapter(unittest.TestCase):
    """«Chapter 8» under «9. Connections», and so on to the end of the guide.

    Both `docs-crm` guides carried a figure caption naming the chapter *before* the one it sits in,
    for every figure from §9 onward - six in each language. It dates from the insertion of «9.
    Connections», which pushed every heading below it up by one and left the captions where they
    were: the enumeration trap, with the list being the guide's own numbering.

    Nothing was checking, and the failure is quiet by construction - a reader who follows «Chapter 9»
    from a picture of the health audit lands on the connections, decides they misread, and carries
    on.

    Derived from the document: a caption's number is whatever the nearest `<h2>` above it says. That
    is the definition of «its own chapter», and it needs no list.

    **The limit, stated:** it reads `<h2>` headings that open with a number and captions that say
    «Chapter N» or «Capitolo N». A figure introduced with a different word, or under a heading that
    numbers itself differently, is invisible here rather than wrong.
    """

    GUIDES = ['site/docs-crm.html', 'site/it/docs-crm.html',
              'site/docs-analytics.html', 'site/it/docs-analytics.html']

    def pairs(self, rel):
        s = (ROOT / rel).read_text(encoding='utf-8')
        heads = [(m.start(), m.group(1)) for m in re.finditer(r'<h2 id="[^"]*">\s*([\w.]+)\.', s)]
        out = []
        for m in re.finditer(r'(?:Chapter|Capitolo) ([\w.]+)', s):
            above = [n for pos, n in heads if pos < m.start()]
            if above:
                out.append((m.group(1), above[-1]))
        return out

    def test_there_are_captions_to_check(self):
        total = sum(len(self.pairs(rel)) for rel in self.GUIDES)
        self.assertGreater(total, 8, f'only {total} numbered caption(s) found - the derivation broke')

    def test_each_caption_names_the_chapter_it_sits_in(self):
        wrong = []
        for rel in self.GUIDES:
            for said, actual in self.pairs(rel):
                if said != actual:
                    wrong.append(f'{rel}: a caption says chapter {said} and sits in chapter {actual}')
        self.assertEqual(wrong, [], 'these send a reader to the wrong chapter:\n  ' + '\n  '.join(wrong))


class EveryStoredKeyIsAccountedFor(unittest.TestCase):
    """What the extensions write down is what the privacy page describes.

    Three things were stored and in no row: the heights the reader drags the preview and detail panes
    to, the timestamp the settings page writes so an open panel knows to re-read, and the Analytics
    export defaults - which live in IndexedDB while the page put «export defaults» under
    `chrome.storage.local`, true of the CRM only.

    None of the three is sensitive, and that is exactly why they went unlisted for so long: nobody
    weighs a pane height. But a privacy page is a claim to be *complete*, and a reader who finds a
    key in DevTools that the page does not mention has no way to tell «too small to list» from «not
    disclosed». The value of the page is that the question never arises.

    Derived from the code: every key written to `chrome.storage.local`, `chrome.storage.session` or
    IndexedDB, in either product, must be **named** in the page - and `KNOWN_AS` is where a key whose
    row calls it something a reader would recognise says so, with the row's own words. That table is
    a translation, not an exemption: a key missing from it *and* from the page is a finding.

    **The limit, stated:** it reads the key at a literal `set({ key` or `idbHandle.set('key'`, so a
    key whose name is computed is invisible here. There is none today.
    """

    # A key the page describes in the reader's words rather than the code's. The phrase is what the
    # page must contain, so changing the row breaks this rather than passing silently.
    KNOWN_AS = {
        'aicfg': 'AI engine choice',
        'erParams': 'diagram layout settings',
        'erDrawMax': 'diagram layout settings',
        'exportScope': 'export defaults',
        'exportScopeAnalytics': 'export defaults',
        'rxShortcuts': 'saved search patterns',
        'sampleWs': 'the sample workspace',
        'tabPrefs': 'which side-panel tabs you show',
        'tabAccessView': 'access record',
        'zohoDc': 'fallback Zoho data centre',
        'rootDir': 'handle for the working folder',
        'activeWs': 'which workspace was last active',
        'activeWsAnalytics': 'which workspace was last active',
        'previewH': 'preview and detail panes',
        'detailH': 'preview and detail panes',
        'settingsStamp': 'timestamp the settings page writes',
        'aikeys': 'unlocked',
        'graphData': 'the drawing it is given',
    }

    def written(self):
        keys = {}
        for f in sorted((ROOT / 'apps').glob('*/*.js')):
            src = f.read_text(encoding='utf-8')
            for m in re.finditer(r"storage\.(?:local|session)\.set\(\{\s*\[?([A-Za-z_]\w*)", src):
                name = m.group(1)
                # `set({ [SESSION]: ... })` writes the *value* of a constant, not the word. Resolved
                # from the same file, because a check that reports the identifier is reporting the
                # code's private name for something the page cannot be expected to use.
                const = re.search(rf"^\s*const {re.escape(name)} = '([\w-]+)';", src, re.M)
                keys.setdefault(const.group(1) if const else name, set()).add(f.parent.name)
            for m in re.finditer(r"idbHandle\.set\('([\w]+)'", src):
                keys.setdefault(m.group(1), set()).add(f.parent.name)
        return keys

    def test_the_derivation_finds_the_keys(self):
        keys = self.written()
        self.assertGreater(len(keys), 8, f'only {len(keys)} stored key(s) found - the derivation broke')

    def test_every_key_is_described_on_the_privacy_page(self):
        # Whitespace collapsed: the page wraps its prose, and «the sample\n          workspace» is the
        # same sentence as «the sample workspace». Searching the raw file reported two rows that are
        # there, which is a check misreading its own subject.
        page = ' '.join((ROOT / 'site' / 'privacy.html').read_text(encoding='utf-8').split())
        unlisted = []
        for key in sorted(self.written()):
            if key in page:
                continue
            phrase = self.KNOWN_AS.get(key)
            if phrase and phrase in page:
                continue
            unlisted.append(key if not phrase else f'{key} (described as "{phrase}", which is not on the page)')
        self.assertEqual(unlisted, [],
                         'these are written to the reader\'s machine and the privacy page describes '
                         f'none of them, so «not listed» and «not disclosed» look the same: {unlisted}')


class EveryPermissionIsJustifiedAndEveryJustificationIsAsked(unittest.TestCase):
    """The listing's justification sections are the manifest's permission list, written out by hand.

    `manifest.json` declares what the extension asks for; `store/<app>/store-listing.md` carries one
    numbered section per permission, because the dashboard has one box per permission and a box left
    empty stops the submission at the form. The two lists were kept in step by whoever remembered.

    Nothing compared them. Measured by adding `alarms` to **both** manifests: 376 Python tests, every
    checker, `sitecheck` - all green. It survives specifically because the one check that looks at
    these sections compares the **two listings against each other**, so a permission added to both
    products and justified in neither is symmetric and therefore invisible. That is what a copy does:
    it is checked against the other copy and never against the thing it copies.

    So this reads the manifests. A permission with no section is a dashboard box that would be pasted
    from nothing, and a section for a permission nobody asks for is a justification Google will read
    beside a manifest that does not contain it - CLAUDE.md's «declare only what we have; have
    everything we declare», on the one surface where the two lists are a day and a dashboard apart.

    **The limits, stated.** It matches a section by its *title* - `## N. <name> justification` - so a
    justification written under a heading of another shape is invisible to it, which is why the count
    of what it matched is asserted rather than assumed. Host permissions are one section however many
    hosts there are, by the decision recorded in CLAUDE.md: the field explains why the extension
    reaches them at all, and the manifest inside the package is the list. And it says nothing about
    what a justification *says* - `dashcheck` is what compares the text against the dashboard.
    """

    def apps(self):
        return sorted(p.name for p in (ROOT / 'apps').iterdir()
                      if (p / 'manifest.json').exists())

    def test_the_two_lists_are_one_list(self):
        seen = 0
        for app in self.apps():
            man = json.loads((ROOT / 'apps' / app / 'manifest.json').read_text(encoding='utf-8'))
            asked = set(man.get('permissions') or []) | set(man.get('optional_permissions') or [])
            if man.get('host_permissions'):
                asked.add('Host permission')
            text = (ROOT / 'store' / app / 'store-listing.md').read_text(encoding='utf-8')
            justified = {m.group(1).strip() for m in
                         re.finditer(r'^## \d+\. (.+?) justification\b', text, re.M)}
            # The denominator, by a cruder method than the check: every heading with the word in it
            # at all. A section the careful pattern cannot read is a finding **about this test**, and
            # it is raised before anything about the listings - it was found by planting one numbered
            # `8b`, which the careful pattern skipped in silence and reported nothing.
            crude = {m.group(1).strip() for m in
                     re.finditer(r'^#+ *[\w.]* *(.+?) justification\b', text, re.M)}
            self.assertEqual(sorted(crude - justified), [],
                             f'{app}: these justification headings are not in the shape this check '
                             f'reads, so it says nothing about them: {sorted(crude - justified)}')
            seen += len(justified)
            self.assertEqual(
                sorted(asked - justified), [],
                f'{app}: the manifest asks for these and the listing justifies none of them, so the '
                f'dashboard has a box that would be pasted from nothing: {sorted(asked - justified)}')
            self.assertEqual(
                sorted(justified - asked), [],
                f'{app}: the listing justifies these and the manifest does not ask for them, so the '
                f'submission argues for access it does not want: {sorted(justified - asked)}')
        # The denominator, by the cruder method: a listing whose headings stopped matching would
        # otherwise pass with two empty sets and report nothing at all.
        self.assertGreaterEqual(seen, 8,
                                f'only {seen} justification section(s) matched across the listings - '
                                'the heading shape changed and this check stopped reading them')


class TheTwoHalvesOfLiveSyncReachTheSamePages(unittest.TestCase):
    """A page with one of the two content scripts on it is a half-installed live sync.

    Zoho CRM injects two: `hook.js` into the page's MAIN world, where it notices a save, a deletion
    or a creation, and `content-bridge.js` into the isolated world, which is the only thing listening
    for what the hook posts. Their `matches` are two hand-written copies of one list of data centres -
    eighteen entries each, kept in step by whoever remembers.

    They do not fail loudly when they come apart. A page with the hook and no bridge posts notices to
    nobody; a page with the bridge and no hook produces none, and the panel simply never hears that
    anything changed. Measured by dropping the two `zohocloud.ca` entries from the hook's block:
    the whole battery green but for the screenshots noticing a file under `apps/` had moved.

    The criterion comes off the values rather than off a count, the same way the duplicated-constant
    check does: two blocks that **share a match** are covering the same pages and must cover exactly
    the same pages. Two with nothing in common are two different jobs and are left alone - so a
    product that one day injects something else somewhere else needs no exception written for it.

    Also here because it belongs to the same fact: a page listed in `matches` and not in
    `host_permissions` is a script Chrome will inject into a page the extension may not read.

    **The limits, stated.** It compares the patterns as written. Two spellings of one page -
    `https://crm.zoho.com/*` and `https://*.zoho.com/*` - would read as different pages, which is a
    false finding rather than a silent pass. It says nothing about whether either script does its job
    on those pages; `tests/panel.test.mjs` drives the vocabulary they share.
    """

    def test_blocks_that_share_a_page_share_all_of_them(self):
        compared = 0
        for app in sorted(p.name for p in (ROOT / 'apps').iterdir() if (p / 'manifest.json').exists()):
            man = json.loads((ROOT / 'apps' / app / 'manifest.json').read_text(encoding='utf-8'))
            blocks = man.get('content_scripts') or []
            hosts = set(man.get('host_permissions') or [])
            for b in blocks:
                what = ', '.join(b.get('js') or ['?'])
                stray = sorted(set(b.get('matches') or []) - hosts)
                self.assertEqual(
                    stray, [],
                    f'{app}: {what} is injected into pages the manifest asks no permission for, so '
                    f'Chrome puts a script where the extension may not read: {stray}')
            for i in range(len(blocks)):
                for j in range(i + 1, len(blocks)):
                    a, b = set(blocks[i].get('matches') or []), set(blocks[j].get('matches') or [])
                    if not (a & b):
                        continue          # two different jobs, not two copies of one list
                    compared += 1
                    ja = ', '.join(blocks[i].get('js') or ['?'])
                    jb = ', '.join(blocks[j].get('js') or ['?'])
                    self.assertEqual(
                        sorted(a - b), [],
                        f'{app}: {ja} runs on these and {jb} does not, so on those pages one half of '
                        f'live sync is there and the other is not, in silence: {sorted(a - b)}')
                    self.assertEqual(
                        sorted(b - a), [],
                        f'{app}: {jb} runs on these and {ja} does not, so on those pages one half of '
                        f'live sync is there and the other is not, in silence: {sorted(b - a)}')
        self.assertGreaterEqual(
            compared, 1,
            'no two content scripts share a page any more - either they were merged, or this check '
            'has stopped having a subject and should say so rather than pass')


class TheRenderHarnessAnswersWhatTheManifestSays(unittest.TestCase):
    """What the screenshot shim tells the panel about itself is the manifest, not a copy of it.

    Every published screenshot is the shipped page rendered against a stubbed `chrome`, and the panel
    reads its own identity out of `getManifest()` - the header, the export footer and the legal line
    all print `getManifest().name`. `tools/shots.py` supplied that name as a **literal**, in a table
    beside a helper whose docstring records the very lesson it ignored: «an approximation that
    silently drops a field the product reads is a picture of a state the product does not have»,
    written when the same stub answered with the name and nothing else and the data-centre picklist
    came out empty.

    So renaming the product in `manifest.json` left every screenshot saying the old name. Measured:
    the only red is `imgcheck`, and it fires for the wrong reason - it compares a picture with the
    sources it was rendered from, so a changed tool makes it say «re-render», and after the re-render
    it agrees with pictures that name a product that does not exist. A check firing for the right
    reason on the wrong subject is not cover.

    Read by importing the tool rather than by matching its text: what matters is the value it hands
    the page, and a regex over the table would pass the day the table is built some other way.

    **The limits, stated.** It compares the fields the stub is *known* to supply - the name and the
    host permissions, which are the two the panels read off their own manifest. A field added to the
    stub tomorrow is not compared, and the count of products checked is asserted so that a stub that
    stopped supplying anything is a finding rather than a pass.
    """

    def test_the_stub_is_the_manifest(self):
        sys.path.insert(0, str(ROOT / 'tools'))
        try:
            import shots
        finally:
            sys.path.pop(0)
        apps = sorted(p.name for p in (ROOT / 'apps').iterdir() if (p / 'manifest.json').exists())
        self.assertGreaterEqual(len(apps), 2, f'{len(apps)} product(s) found - the derivation broke')
        for app in apps:
            man = json.loads((ROOT / 'apps' / app / 'manifest.json').read_text(encoding='utf-8'))
            self.assertIn(app, shots.NAME,
                          f'{app} has a manifest and the render harness has no name for it, so its '
                          'screenshots are rendered against a page that cannot say what it is')
            self.assertEqual(
                shots.NAME[app], man['name'],
                f'{app}: the screenshots are rendered with the name «{shots.NAME[app]}» and the '
                f'manifest says «{man["name"]}» - every published picture states the wrong one')
            self.assertEqual(
                json.loads(shots.hosts_of(app)), man.get('host_permissions', []),
                f'{app}: the shim answers a different host list from the manifest, so anything the '
                'panel derives from it is photographed wrong')


class TheSettingsShotIsOfAProductInUse(unittest.TestCase):
    """The screenshot stub must not hand the page a state the page draws as «nothing here».

    Every published picture of the settings page is the shipped page rendered against a stubbed
    `chrome` and a stubbed `idbHandle`. `showRoot()` asks `idbHandle.get('rootDir')` for the working
    folder and, when there is none, writes **«Not set»** into the row. The stub answered `null`, so
    every published settings screenshot showed the page as somebody who has never used the product
    sees it - the one state a reader looking at a screenshot is not trying to learn about.

    The panel shots already record this lesson, in as many words: their Zoho context used to be
    `{ ok: false }` against example.com, «so every Analytics panel shot carried an amber Not on a
    Zoho Analytics tab - the off-platform state, photographed and published to the Store». The source
    beside it was left answering nothing.

    So: the empty state is read out of the **page**, and the stub is required not to be able to
    produce it. Both halves derived - the sentence is not written here, it is taken from
    `showRoot()`, so rewording it in the product does not leave this check watching for a string
    nobody writes any more.

    **The limits, stated.** It reads the stub as text and the page as text: it proves the stub does
    not answer `null` for the folder and that the page has an empty state to avoid, not that the
    rendered picture is right - only opening the image does that, and `imgcheck` holds the images
    against their sources. It covers the one source whose absence the page draws; a stub that starts
    answering nothing for something else is not compared.
    """

    def test_the_folder_row_is_not_photographed_empty(self):
        sys.path.insert(0, str(ROOT / 'tools'))
        try:
            import shots
        finally:
            sys.path.pop(0)
        stub = shots.OPTIONS_STUB.format(name='"x"', stored='{}', script='', hosts='[]')

        for app in sorted(p.name for p in (ROOT / 'apps').iterdir() if (p / 'options.js').exists()):
            src = (ROOT / 'apps' / app / 'options.js').read_text(encoding='utf-8')
            m = re.search(r"idbHandle\.get\('(\w+)'\)", src)
            if not m:
                continue                       # this page has no working-folder row
            key = m.group(1)
            empty = re.search(r"if \(!h\) \{ el\.textContent = '([^']+)'", src)
            self.assertIsNotNone(
                empty, f'{app}: showRoot no longer says anything when there is no folder - either the '
                       'row lost its empty state, or this check has stopped reading it')
            i = stub.index('window.idbHandle')
            hand = stub[i:stub.index(';', stub.index('set:', i))]
            self.assertNotIn(
                'get: async () => null', hand,
                f'{app}: the render harness answers no working folder, so every published settings '
                f'screenshot shows the row as «{empty.group(1)}» - a picture of a product nobody has '
                'used yet, which is the one state the reader is not looking at it to learn about')
            self.assertIn(
                "queryPermission", hand,
                f'{app}: the stubbed handle cannot answer whether its permission still stands, so the '
                'row is photographed with the «access needs to be granted again» tail it would not '
                'normally carry')
            self.assertIn(key, "rootDir",
                          f'{app}: the page asks idbHandle for «{key}» and this check assumed rootDir')


class WhatDecidesAPictureIsWhatIsHashed(unittest.TestCase):
    """The staleness digest and the encoder are two halves of one answer, joined by a list.

    `source_digest()` decides whether a published image is still a picture of the product, and
    `imgcheck` reports on nothing else. What it hashed was the app's shipped files, the fixture, the
    click script, and **three renderer files written out by name**. `siteimg.py` was not one of them,
    and it is where the width, the WebP quality and the `cwebp` command line live.

    Measured: quality 80 to 70 - which changes the bytes of all 28 published images - and `imgcheck`
    answered «0 findings». Every picture would have stayed at the old encoding until something
    unrelated moved, with nothing saying so. The lesson was already in that function's own docstring,
    «the command that drives it was the one input that could move without any image being
    re-rendered», applied to one file and not to the one it was written in.

    The set is derived now - the two modules that drive a render, and every `tools/<file>` either of
    them names - so a helper added tomorrow is covered the moment something reads it. This holds the
    derivation to two things a list cannot promise: that it contains the drivers themselves, and that
    it does not contain the tool's own output, which would re-render everything on every run.

    **The limits, stated.** It reads the set the tool computes, not the pictures: it proves what is
    watched, not that a watched change is noticed - the run that follows a change does that, and the
    plant behind this case is what showed the gap. A renderer file reached some way other than a
    `"tools" / "name"` path is invisible to the derivation, which is why the count is asserted.
    """

    def test_the_renderers_hash_themselves(self):
        sys.path.insert(0, str(ROOT / 'tools'))
        try:
            import siteimg
        finally:
            sys.path.pop(0)
        names = {f.name for f in siteimg.renderers()}
        self.assertGreaterEqual(
            len(names), 4,
            f'the render set is {sorted(names)} - too small to be the whole of what draws a picture, '
            'so the derivation has stopped finding things')

        # The drivers themselves: the file that encodes, and the file that stubs the page.
        for mod in ('siteimg.py', 'shots.py'):
            self.assertIn(
                mod, names,
                f'{mod} decides what a picture looks like and is not hashed, so changing it leaves '
                'every published image stale with imgcheck reporting none')

        # And never the ledger: a digest that included its own output would move on every run.
        self.assertNotIn(
            siteimg.LEDGER.name, names,
            'the digest includes the file it writes, so every run invalidates every image and the '
            'tool re-renders the whole set for ever')

        # The set is what the digest actually reads, not a second list beside it.
        body = (ROOT / 'tools' / 'siteimg.py').read_text(encoding='utf-8')
        at = body.index('def source_digest')
        self.assertIn(
            'renderers()', body[at:body.index('\n\n\n', at)],
            'source_digest no longer reads the derived set, so this check is watching a helper '
            'nothing uses')


class TheGridCitesChecksThatExist(unittest.TestCase):
    """`CLOSED` is a table maintained by hand, and nothing proved its citations still name anything.

    A cell is closed by naming the check that closes it. That name was never resolved against the
    tree, so a renamed test left the grid asserting a cover nobody could find - the exact failure
    this grid exists to refuse, in the grid itself. Reported from outside.

    Resolved now, as far as each kind can be: a `.test.mjs` citation is matched against the literal
    `test('…')` titles in that file, a Python one against the words of its own description, and a
    `tools/*.py` citation against the file existing - which is all it can say, and it says that
    rather than implying more.

    **The ceiling is 0.** 56 did not resolve when this was written and none do now, and not one of
    the 56 was a missing check:
    read, they are paraphrases - «an overtaken loader publishes nothing» against the real title «an
    overtaken loader on the options page publishes nothing». A description rots quietly where a title
    breaks loudly, which is the whole argument for recording the title. The ceiling comes down as
    they are repaired; a run that pushes it up is a finding, and which of the two reasons it was -
    a citation that rotted, or a resolver that started seeing more - is what the tool prints.
    """

    CEILING = 0

    def test_the_unresolved_citations_only_shrink(self):
        sys.path.insert(0, str(ROOT / 'tools'))
        try:
            import matrix
        finally:
            sys.path.pop(0)
        cited = matrix.citations()
        self.assertGreaterEqual(len(cited), 100,
                                f'{len(cited)} citation(s) read - the derivation broke')
        loose = [c for c in cited if c[3] in ('MISSING', 'unresolved')]
        self.assertLessEqual(
            len(loose), self.CEILING,
            f'{len(loose)} citations do not resolve, against a ceiling of {self.CEILING}. A cell '
            f'whose check cannot be found is a cell nobody can verify: {[c[4][:60] for c in loose[:3]]}')
        # And every citation that does resolve must resolve *exactly* where an exact match is
        # possible - a `.test.mjs` title either is one or is not, so «described» is not an answer there.
        for ck, sk, cap, how, what in cited:
            if what.split(':')[0].endswith('.test.mjs'):
                self.assertIn(how, ('exact', 'MISSING'),
                              f'({ck}, {sk}, {cap}) resolved a Node title as «{how}»')

    def test_every_closed_cell_names_a_capability_its_surface_has(self):
        sys.path.insert(0, str(ROOT / 'tools'))
        try:
            import matrix
        finally:
            sys.path.pop(0)
        for (ck, sk, cap) in matrix.CLOSED:
            if cap == '*':
                self.assertIn((ck, sk), matrix.WHOLE_SURFACE,
                              f'({ck}, {sk}) claims the whole surface and says nowhere why it is exhaustive')
                continue
            have = matrix.capabilities_of(sk)
            self.assertIn(cap, have,
                          f'({ck}, {sk}) is closed for «{cap}» and that surface implements {have} - '
                          'either the capability is misfiled or the probe stopped seeing it')


class CoverageMeasuresWhatTheRepositoryShips(unittest.TestCase):
    """The denominator was written by hand, so it flattered the numerator it divided.

    `subject()` was a list of globs - `apps/*/*.js`, `site/*.html`, a few more - and the report said
    «70 shipped files, 0 opened by no check at all». Outside that list: `README.md`, `site/llms.txt`,
    `site/_headers`, `site/sitemap.xml`, every Store submission input, the workflows and the release
    tooling. **77 files of 147**, and a run that had read half the subject printed a full house.

    It is derived now, from the things that actually decide: `build.sh` copies `apps/<app>/.` whole,
    `site/.assetsignore` says what is published, a submission is built from everything under
    `store/`, and a workflow or `build.sh` can turn a right tree into a wrong package. This case
    re-derives the two large categories **by a cruder method than the tool uses** and compares - the
    discipline this repository asks of anything that inspects a tree, applied to the tool whose whole
    job is inspecting one.

    It also holds the three measures apart. «Opened» counts a panel a checker read to find a product
    name, which says nothing about the panel; «read by a tool that proves its own reach» is the
    nearest this can get to «examined». They were one number, and being one is what made it flatter.

    **The limits, stated.** It does not run the whole tool - `deadcode` alone is half a minute, and a
    suite that takes that for one case is a suite people stop running. The single-run property is
    proved on one cheap checker instead, which is where the defect was: two functions, two runs, two
    minutes without a line of output.
    """

    def cov(self):
        sys.path.insert(0, str(ROOT / 'tools'))
        try:
            import coverage
            return coverage
        finally:
            sys.path.pop(0)

    def test_the_subject_is_what_ships_and_what_is_published(self):
        cats = self.cov().subject()
        got = {f.resolve() for v in cats.values() for f in v}
        self.assertGreaterEqual(len(got), 120,
                                f'the subject is {len(got)} files - it was 147 when this was written, '
                                'and 70 when it was a hand-written list of globs')

        # Crude re-derivation, on purpose: a second walk that knows nothing about how `subject()`
        # groups things. Anything it finds and the tool does not is a hole in the denominator.
        crude = set()
        for f in (ROOT / 'apps').rglob('*'):
            if f.is_file() and f.name != '.DS_Store':
                crude.add(f.resolve())
        ignored = {ln.strip() for ln in (ROOT / 'site/.assetsignore').read_text(encoding='utf-8').split('\n')
                   if ln.strip() and not ln.startswith('#')}
        for f in (ROOT / 'site').rglob('*'):
            if f.is_file() and f.relative_to(ROOT / 'site').parts[0] not in ignored \
                    and f.relative_to(ROOT / 'site').as_posix() not in ignored:
                crude.add(f.resolve())
        for f in (ROOT / 'store').rglob('*'):
            if f.is_file():
                crude.add(f.resolve())
        for f in (ROOT / '.github/workflows').glob('*.yml'):
            crude.add(f.resolve())
        for name in ('README.md', 'build.sh', 'tools/release.sh'):
            crude.add((ROOT / name).resolve())
        missing = sorted(p.relative_to(ROOT).as_posix() for p in crude - got)
        self.assertEqual(missing, [],
                         f'{len(missing)} file(s) ship or are published and are outside the '
                         f'denominator, so a coverage figure divides by less than the tree: {missing[:5]}')

        # And nothing the platform is told not to publish is counted as published.
        published = {f.resolve() for f in cats['site']}
        for name in ignored:
            p = (ROOT / 'site' / name).resolve()
            self.assertNotIn(p, published,
                             f'{name} is excluded from the upload by .assetsignore and is counted as '
                             'published, so the denominator contains a file with no URL')

    def test_the_three_measures_stay_three(self):
        cov = self.cov()
        src = (ROOT / 'tools/coverage.py').read_text(encoding='utf-8')
        for key in ('repository_subject_files', 'files_opened_for_any_reason',
                    'files_opened_by_a_self_auditing_checker', 'files_opened_by_nothing'):
            self.assertIn(key, src,
                          f'the report no longer separates «{key}» - «opened» and «examined» were one '
                          'number once, and being one is what let it flatter')
        self.assertFalse(hasattr(cov, 'touched_by'),
                         'the two-run shape is back: reads and output were gathered by separate '
                         'functions, so every checker ran twice')

    def test_each_checker_is_run_once(self):
        cov = self.cov()
        sys.path.insert(0, str(ROOT / 'tools'))
        try:
            import csscheck
        finally:
            sys.path.pop(0)
        calls = []
        real, cov_checkers = csscheck.main, cov.CHECKERS
        csscheck.main = lambda *a, **k: (calls.append(1), real(*a, **k))[1]
        cov.CHECKERS = ['csscheck']
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                cov.main()
        finally:
            csscheck.main, cov.CHECKERS = real, cov_checkers
        self.assertEqual(len(calls), 1,
                         f'a checker ran {len(calls)} times for one report - it was two, which is why '
                         'the tool took about two minutes and said nothing while it did')


class EveryAsyncScopeShippedIsSomethingTheCheckerCanEnter(unittest.TestCase):
    """`asynccheck` read function declarations and nothing else, and the cells said «closed».

    118 awaits and 45 `.then()` callbacks sat outside any scope it enters - 40 in `apps/crm/options.js`
    alone, 11 per diagram window, which is the whole of that surface. The tool said so honestly in its
    headline, and the grid still recorded the panels' «await» cells as covered: an on/off value that
    was not true of everything it stood for. That is the principle this repository now works to - if a
    cell cannot be represented by one boolean, split it until each one can - and here the split is
    between «read» and «not read», with the second holding most of the subject.

    The way out was not a second parser. A parser is a dependency this project does not have, and the
    two attempts at widening the line-based reader produced 636 findings and then 171, none of them
    real. It is a **source convention** instead: every async scope the two extensions and the site
    ship is a named function declaration, and a callback is a reference to one. Then the reader that
    exists reaches all of it. `tools/asyncscopes.txt` is the migration list, and the ceiling below is
    what makes «it goes to zero» a check rather than a sentence.

    **The limits, stated.** The scanner is line-based like the rest of the file: it finds the shapes,
    not their bodies. And `.then(fn)` is accepted on the strength of `fn` being a declaration on the
    same page - which is exact, because the page's declarations are derived, but says nothing about
    what that declaration does.
    """

    #: What is still written the old way. It may only fall - a conversion lowers it, and nothing
    #: raises it, because a new scope written the old way is a finding on the day it is written.
    CEILING = 0

    def ac(self):
        sys.path.insert(0, str(ROOT / 'tools'))
        try:
            import asynccheck
            return asynccheck
        finally:
            sys.path.pop(0)

    def test_the_migration_list_only_falls(self):
        n = len(self.ac().scope_findings())
        self.assertLessEqual(n, self.CEILING,
                             f'{n} async scopes are not a named declaration, and the ceiling is '
                             f'{self.CEILING}. A new one is a finding on the day it is written; if '
                             'this rose because the scanner started seeing more, say which in the '
                             'commit and lower it again by converting.')
        if n < self.CEILING:
            self.fail(f'{n} left, ceiling still {self.CEILING} - lower it in the same change, or the '
                      'ground gained is given straight back')

    def test_a_regex_literal_is_not_a_string(self):
        # This is the defect that hid a third of the subject. `/[&<>"']/g` in each options page opened
        # a string at its `"` and closed it at another one forty characters later, and every async
        # arrow in between vanished - eleven of them in `apps/crm/options.js`, reported as a clean
        # file. A blanker fails silently by definition: what it eats stops being visible to anything.
        blanked = self.ac()._blank_non_code(
            'const e = (s) => s.replace(/[&<>"\']/g, c => c);\n'
            'el.onclick = async () => { await go(); };\n')
        self.assertIn('async () =>', blanked,
                      'a regular-expression literal containing a quote swallowed the code after it')
        self.assertEqual(blanked.count('\n'), 2, 'blanking moved a line boundary')

    def test_a_named_continuation_is_read_and_an_anonymous_one_is_not(self):
        ac = self.ac()
        src = 'function done() { cache = 1; }\nfunction go() { p().then(done); }\n'
        tmp = ROOT / 'apps/crm/_scopes_probe.js'
        tmp.write_text(src, encoding='utf-8')
        try:
            self.assertEqual(ac.unread_scopes('apps/crm/_scopes_probe.js'), [],
                             '`.then(done)` is a reference to a declaration this tool reads, so it is '
                             'not a scope it misses - that distinction is the whole convention')
            tmp.write_text(src.replace('.then(done)', '.then(() => { cache = 1; })'), encoding='utf-8')
            got = ac.unread_scopes('apps/crm/_scopes_probe.js')
            self.assertEqual([s for _, _, s in got], ['.then() callback'],
                             'an anonymous continuation is a scope nothing enters, and it has to be '
                             'reported as one')
        finally:
            tmp.unlink()

    def test_a_new_scope_written_the_old_way_is_a_finding(self):
        # The gate itself, on a real file rather than on a pattern: the check must fail when somebody
        # writes the old shape tomorrow, which is the only thing that makes a migration list finish.
        f = ROOT / 'apps/crm/connections.js'
        before = f.read_text(encoding='utf-8')
        f.write_text(before + '\nconst planted = async () => { await Promise.resolve(); };\n',
                     encoding='utf-8')
        try:
            out = subprocess.run([sys.executable, str(ROOT / 'tools/asynccheck.py')],
                                 capture_output=True, text=True, cwd=str(ROOT))
            self.assertEqual(out.returncode, 1, 'a new async arrow in a shipped file passed the gate')
            self.assertIn('connections.js', out.stdout)
        finally:
            f.write_text(before, encoding='utf-8')



class TheOnlyCheckThatExecutesTheProduct(unittest.TestCase):
    """Where the browser probe sits in the battery, and why it is not last.

    `set -e` ends the run at the first non-zero exit. A check placed after the static ones therefore
    does not run whenever any of them is red - and «any of them is red» is precisely the state in
    which you most want to know whether the product still starts. It happened: `imgcheck` was red
    because the site images were mid-render, the run stopped there, and a template literal that ended
    early inside a comment shipped with the probe never executed.

    So the order is a claim, and this is the check that holds it: the only thing in the battery that
    *executes* the shipped panels answers before anything that merely reads them.
    """

    def run_sh(self):
        s = (ROOT / 'tests' / 'run.sh').read_text(encoding='utf-8')
        lines = [l for l in s.split('\n') if l and not l.lstrip().startswith('#')]
        return lines

    def test_the_probe_runs_before_anything_that_only_reads(self):
        lines = self.run_sh()
        probe = [i for i, l in enumerate(lines) if 'tools/probe.py' in l]
        readers = [i for i, l in enumerate(lines)
                   if re.search(r'tools/\w*check\w*\.py', l) or 'tools/sitemap.py' in l]
        # If neither is here any more, this case is measuring nothing and says so rather than passing.
        self.assertTrue(probe, 'tests/run.sh no longer runs tools/probe.py - either it was removed, '
                               'in which case nothing in the battery executes the panels, or it was '
                               'renamed and this case is the thing that is broken')
        self.assertGreater(len(readers), 5, 'no static checkers found in tests/run.sh - this case '
                                            'cannot be comparing anything, so it is the broken one')
        self.assertLess(probe[0], min(readers),
                        'tools/probe.py runs after a checker that only reads source. `set -e` means '
                        'it will not run at all on the day one of them is red, which is the day it '
                        'is worth most.')



class TheSuiteCountsItself(unittest.TestCase):
    """That `tests/run.sh` compares the counts its two suites report - not that it counts them here.

    Reported from outside, twice, and the second report was right about the first fix. `tail -3` had
    stopped showing «Ran N tests / OK» because the cases' own printing grew past it: that was a
    visibility hole and it is closed. The floor written beside it was the wrong instrument. It counted
    *declarations*, and cases here expand at run time - 811 `test(` in the node files against 918
    executed - so a fixture dropped from a loop shrinks the run without changing a line of source,
    which is precisely the shrinkage a floor is for. The python half compared `n * 3` against 391 and
    could not have failed short of losing two thirds of the file.

    So the floors live in `tests/run.sh`, where the numbers the suites *print* are, and this case
    checks that the script still consumes them.

    **And then this class promised a measurement it did not make.** «What is asserted here is the
    mechanism, because the numbers themselves are asserted by the script on every run» was true of
    the script and false of the two assertions underneath it: one compared `PY_FLOOR` against a
    literal 300 against a suite of four hundred, and the other compared `NODE_FLOOR` against a
    declaration count its own paragraph had just called the wrong instrument. The python half is
    measured properly now - every case there is a `def test_` and none expands, so the declaration
    count is the run count - and the node half says in its own docstring that it is a lower bound
    and where the real comparison happens.
    """

    def script(self):
        return (ROOT / 'tests' / 'run.sh').read_text(encoding='utf-8')

    def test_the_run_script_compares_both_counts_exactly(self):
        """**Exactly, in both directions - a bound with slack in it stops measuring.**

        These were `-ge` floors, and the run measured 939 node cases against 922 and 402 python
        against 395: seventeen and seven could have stopped running with the battery still green,
        while the comment beside them claimed a rise was recorded in the same commit. Nothing made
        that true. `-eq` does, and the failure has to say which direction it went, because «cases
        stopped running» and «you added cases» are not the same news.
        """
        s = self.script()
        for name, summary in (('NODE_EXPECTED', '# tests'), ('PY_EXPECTED', 'Ran ')):
            self.assertIn(name, s, f'{name} is gone - the suite no longer holds itself to a size')
            self.assertIn(summary, s, f'nothing reads the «{summary}» line the suite prints, so the '
                                      f'number beside {name} is compared against nothing')
        for ran, want in (('NODE_RAN', 'NODE_EXPECTED'), ('PY_RAN', 'PY_EXPECTED')):
            self.assertRegex(s, rf'\[ "\$\{{{ran}:-0\}}" -eq "\${want}" \]',
                             f'{ran} is not compared for equality with {want} - a floor lets cases '
                             f'disappear up to the slack in it')
            self.assertNotRegex(s, rf'\$\{{{ran}:-0\}}" -ge',
                                f'{ran} is still compared with -ge somewhere')
        self.assertIn('up from', s, 'a rise fails without telling the reader it is a rise')

    def test_the_expectations_are_reachable(self):
        """A number nothing can reach is a suite that always fails; one under what runs is one that
        measures nothing. Both are read from the script and compared against a count taken here, so
        the two come from different places.

        Python is exact because none of its cases expands at run time - every one is a `def test_`.
        Node is a lower bound and stays one: its cases are generated by loops over both products,
        every fixture and every shipped page, so the declaration count is below what runs. What the
        script does with the runtime number is the assertion above; this one only keeps the written
        figures inside the range where they can do their job.
        """
        s = self.script()
        want = {k: int(re.search(rf'^{k}=(\d+)', s, re.M).group(1)) for k in ('NODE_EXPECTED', 'PY_EXPECTED')}

        # **Only the file the battery runs.** This counted every `tests/*.py`, and `run.sh` executes
        # `tests/tools_test.py` alone - so a second file made the two numbers unreconcilable: raising
        # `PY_EXPECTED` to satisfy this broke the `-eq` in the script, and lowering it broke this. A
        # population one number describes and the other does not is not a check, it is a trap for
        # whoever adds the file.
        collected = ROOT / 'tests' / 'tools_test.py'
        self.assertIn(collected.name, s, f'{collected.name} is not what the battery runs any more')
        methods = len(re.findall(r'(?m)^\s*def test_\w+', collected.read_text(encoding='utf-8')))
        self.assertGreater(methods, 0, 'no python cases found at all - the sweep broke')
        stray = [f.name for f in sorted((ROOT / 'tests').glob('*_test.py')) if f != collected]
        self.assertEqual(stray, [],
                         f'{stray} sit beside the suite and the battery never runs them - either add '
                         f'them to tests/run.sh or they are cases nobody executes')
        self.assertEqual(want['PY_EXPECTED'], methods,
                         f"PY_EXPECTED is {want['PY_EXPECTED']} and {methods} python cases are declared. "
                         f'None of them expands at run time, so the two are the same number or one of '
                         f'them is wrong.')

        declared = 0
        for f in sorted((ROOT / 'tests').glob('*.test.mjs')):
            declared += len(re.findall(r'(?m)^\s*test\(', f.read_text(encoding='utf-8')))
        self.assertGreater(declared, 0, 'no node cases found at all - the sweep broke')
        self.assertGreater(want['NODE_EXPECTED'], declared,
                           f"NODE_EXPECTED is {want['NODE_EXPECTED']} and {declared} cases are declared "
                           'in source - a number at or below the declaration count cannot notice a loop '
                           'that stopped expanding')


class ImagesAreAGateOnlyWhenPublishing(unittest.TestCase):
    """Where «these pictures are older than the panel» refuses, and where it only says so.

    Rendering the site's 28 screenshots takes about seven minutes, and in a day of panel work every
    one of them comes out byte-identical - the stamp moves because a *source* moved, not because a
    pixel did. Holding the battery to it meant paying that on every commit that touched `apps/`, and
    telling somebody who had edited a comment to go and re-render the product. Asked for by the
    author, on the day the cost was measured: **the site has to show the product when the site is
    published; between one release and the next, a stale picture is a queue.**

    What is not deferred is the *fact*: `imgcheck` prints the same line either way, so the state is
    never hidden - only the refusal moves, to `--publishing`, which `tools/prepare.sh` passes as step
    zero of the release routine, after it has rendered.
    """

    def run_it(self, *args, stale=False):
        stamp = ROOT / 'tools' / 'imgstamp.json'
        orig = stamp.read_text(encoding='utf-8')
        if stale:
            d = json.loads(orig)
            d[next(iter(d))]['from'] = 'stale-on-purpose'
            stamp.write_text(json.dumps(d, indent=2), encoding='utf-8')
        try:
            return subprocess.run([sys.executable, str(ROOT / 'tools' / 'imgcheck.py'), *args],
                                  cwd=ROOT, capture_output=True, text=True)
        finally:
            stamp.write_text(orig, encoding='utf-8')

    def test_a_stale_stamp_is_a_note_in_the_battery_and_a_finding_when_publishing(self):
        note = self.run_it(stale=True)
        self.assertEqual(note.returncode, 0,
                         'the battery refuses a stale picture again - that is seven minutes on every '
                         f'commit that touches apps/:\n{note.stdout}')
        self.assertIn('has changed since these images were rendered', note.stdout,
                      f'the battery no longer says the pictures are behind:\n{note.stdout}')
        gate = self.run_it('--publishing', stale=True)
        self.assertEqual(gate.returncode, 1,
                         f'a release would publish pictures older than the panel:\n{gate.stdout}')

    def test_the_release_routine_passes_the_flag(self):
        prep = (ROOT / 'tools' / 'prepare.sh').read_text(encoding='utf-8')
        self.assertRegex(prep, r'imgcheck\.py --publishing',
                         'prepare.sh runs imgcheck without --publishing, so nothing refuses a stale '
                         'picture at the one moment it matters')


if __name__ == '__main__':
    unittest.main(verbosity=2)
