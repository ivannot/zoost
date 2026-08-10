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
import json
import pathlib
import re
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

    def test_the_workflow_reads_the_same_path(self):
        # One path, two readers: the tagging step and the workflow that publishes. If they disagree,
        # release.sh passes and the run fails after the tag is public.
        wf = (ROOT / '.github/workflows/release.yml').read_text(encoding='utf-8')
        self.assertIn('store/$APP/whatsnew/$VERSION.md', wf)
        sh = (ROOT / 'tools/release.sh').read_text(encoding='utf-8')
        self.assertIn('store/$APP/whatsnew/$VERSION.md', sh)
        # Only body_path: `body` and `body_path` together leave it to the action which one wins.
        self.assertIn('body_path:', wf)
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
            self.assertEqual(rec['files'],
                             [f'{app}_{n}.png' for n in range(1, len(self.shots.STORE[app]) + 1)])


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


if __name__ == '__main__':
    unittest.main(verbosity=2)
