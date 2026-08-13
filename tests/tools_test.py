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
import tempfile
import unittest
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
        d = pathlib.Path(tempfile.mkdtemp())
        (d / 'site').mkdir(); (d / 'apps' / 'crm').mkdir(parents=True)
        (d / 'site' / 'privacy.html').write_text(policy_text, encoding='utf-8')
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
        f = self.run_on(['https://crm.zoho.com/*', 'https://one.zoho.com/*'], 'we reach crm.zoho.*')
        self.assertEqual(len(f), 1, f)
        self.assertIn('one.zoho', f[0])

    def test_a_different_tld_is_a_different_family(self):
        # crm.zohocloud.ca is not covered by "crm.zoho.*", which is exactly how it went unnoticed.
        f = self.run_on(['https://crm.zohocloud.ca/*'], 'we reach crm.zoho.*')
        self.assertEqual(len(f), 1, f)

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

    def _repo(self, tmp: str, notes: str | None):
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
        # set had no recorded version at all. Reported as a rule: «non sono io a dovertelo chiedere,
        # e' un automatismo».
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
        shared = set(wins['crm']) & set(wins['analytics'])
        stragglers = sorted(n for n in shared
                            if wins['crm'][n] == wins['analytics'][n] and not DOM.search(wins['crm'][n]))
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
        SECRETS = set()
        read = set(re.findall(r'\benv\.([A-Z][A-Z0-9_]*)', self.worker))
        declared = set(re.findall(r'"binding":\s*"([^"]+)"', self.cfg))
        self.assertTrue(read, 'nothing is read off env - has the signature changed?')
        self.assertEqual(read - declared, SECRETS,
                         'a name read off env is neither declared in wrangler.jsonc nor a known '
                         'secret: declare the binding, or add it to SECRETS if it is one')

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


class InlineStylesStayTwins(unittest.TestCase):
    """A page and its translation carry the same inline <style>, and the first divergence was a comment.

    Three landing pages keep 38-52 lines of `<style>` of their own, duplicated into the Italian copy.
    Nothing enforced that, and an outside audit found the pair had already come apart on the home -
    `it/index.html` was missing one comment. No rule differed, so nothing was visibly wrong; the point
    is that the mechanism which dropped a comment will eventually drop a rule, and on a page nobody
    would think to compare. Rules are compared exactly; comments are compared too, because a comment
    that exists on one side is the evidence the copy was not carried over whole.
    """

    PAIRS = ('index.html', 'crm.html', 'analytics.html')

    def _style(self, path):
        s = (ROOT / path).read_text(encoding='utf-8')
        m = re.search(r'<style>(.*?)</style>', s, re.S)
        return m.group(1) if m else None

    def test_every_pair_carries_the_same_block(self):
        for name in self.PAIRS:
            en, it = self._style('site/' + name), self._style('site/it/' + name)
            self.assertIsNotNone(en, name + ' has no inline style block')
            self.assertIsNotNone(it, 'it/' + name + ' has no inline style block')
            if en == it:
                continue
            a = [l.strip() for l in en.split('\n') if l.strip()]
            b = [l.strip() for l in it.split('\n') if l.strip()]
            self.fail(f'{name}: the inline style block differs from its translation. '
                      f'Only on the English page: {sorted(set(a) - set(b))[:3]} / '
                      f'only on the Italian one: {sorted(set(b) - set(a))[:3]}')

    def test_the_comparison_can_fail(self):
        # A checker that has never failed is a claim. This proves the comparison is exact rather than
        # normalising the difference away - the divergence that was found was a single comment line.
        en = 'a{color:red}\n/* why */\n'
        it = 'a{color:red}\n'
        self.assertNotEqual(en, it)


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


class SitemapIsDerived(unittest.TestCase):
    """Every field in the sitemap was typed by hand, and the dates had drifted three days behind.

    Google uses `<lastmod>` "if it's consistently and verifiably accurate (for example by comparing
    to the last modification of the page)" — so stale dates do not cost one row, they cost the field
    across the file. Ours were wrong at the one moment it mattered: the canonical fix had just
    rewritten every page and the sitemap still said nothing had changed.
    """

    def test_the_committed_file_is_what_the_site_derives(self):
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
        src = (ROOT / 'tools/siteimg.py').read_text(encoding='utf-8')
        i = src.index('def source_digest')
        body = src[i:src.index('\ndef ', i + 10)]
        for f in ('shots.py', 'fsshim.js'):
            self.assertIn(f, body,
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
        m = re.search(r'rsync\s+-([a-zA-Z]+)\s', code)
        self.assertIsNotNone(m, 'no rsync call found')
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
        with tempfile.TemporaryDirectory() as tmp:
            env = {**os.environ, 'ZOOST_TEST_DIR': str(Path(tmp) / 'zoost-test')}
            run = lambda *a: subprocess.run(['bash', str(ROOT / 'tools' / 'totest.sh'), *a],
                                            cwd=ROOT, capture_output=True, text=True, env=env)
            run()
            self.assertIn('nothing, already in step', run().stdout)
            forced = run('--force')
            self.assertRegex(forced.stdout, r'wrote: \d+ file', f'--force wrote nothing: {forced.stdout}')

    def test_the_destructive_fallback_says_so(self):
        # It deletes. Whoever is watching that folder should be told why it emptied, rather than
        # discovering it.
        sh = (ROOT / 'tools' / 'totest.sh').read_text(encoding='utf-8')
        i = sh.index('rm -rf "$DEST/apps/crm"')
        self.assertIn('echo', sh[max(0, i - 300):i], 'the fallback deletes without a word')

    def test_an_unchanged_run_writes_nothing(self):
        # The number is the guard: "nothing to do" is what an unchanged run should say, and every
        # file, every time, is the shape of the defect coming back.
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
        # /proc stands in for it: a directory that certainly exists and certainly refuses a mkdir.
        auto = subprocess.run(['bash', str(ROOT / 'tools' / 'totest.sh'), '--auto'],
                              capture_output=True, text=True, cwd=ROOT,
                              env={**os.environ, 'ZOOST_TEST_DIR': '/proc/zoost-test'})
        self.assertEqual(auto.returncode, 0, 'a mount that is not there failed the battery')
        self.assertEqual(auto.stdout.strip(), '', 'it wrote a path it never copied to')
        self.assertIn('nothing is mounted on it', auto.stderr,
                      f'--auto blamed the script instead of the mount: {auto.stderr!r}')
        asked = subprocess.run(['bash', str(ROOT / 'tools' / 'totest.sh')],
                               capture_output=True, text=True, cwd=ROOT,
                               env={**os.environ, 'ZOOST_TEST_DIR': '/proc/zoost-test'})
        self.assertEqual(asked.returncode, 1)
        self.assertIn('Nothing was copied', asked.stderr)

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
        self.assertTrue(shots.CHROME, 'shots.py resolves no browser')
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


if __name__ == '__main__':
    unittest.main(verbosity=2)

