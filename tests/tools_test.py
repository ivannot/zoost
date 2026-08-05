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
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))

import sitecheck            # noqa: E402
import htmlcheck            # noqa: E402
import featurecheck         # noqa: E402
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
        self.assertEqual(self.run_on({'a.html': '<link rel="canonical" href="https://zoost.it/a.html">'}), [])

    def test_the_home_may_name_the_bare_origin(self):
        self.assertEqual(self.run_on({'index.html': '<link rel="canonical" href="https://zoost.it/">'}), [])

    def test_a_translated_pair_must_point_both_ways(self):
        # The Italian pages declared their original from the day they were written; the English ones
        # said nothing back. A one-way pair leaves the engine to pick which language a reader lands on.
        f = self.run_on({
            'a.html': '<link rel="canonical" href="https://zoost.it/a.html">',
            'it/a.html': '<link rel="canonical" href="https://zoost.it/it/a.html">'
                         '<link rel="alternate" hreflang="en" href="https://zoost.it/a.html">'
                         '<link rel="alternate" hreflang="it" href="https://zoost.it/it/a.html">',
        })
        self.assertEqual(len(f), 2, f)          # the English page is missing both directions
        self.assertTrue(all(x.startswith('a.html') for x in f), f)

    def test_a_page_with_no_translation_is_not_asked_for_alternates(self):
        self.assertEqual(self.run_on({'a.html': '<link rel="canonical" href="https://zoost.it/a.html">'}), [])

    def test_the_site_is_correct_today(self):
        findings = []
        sitecheck.canonical_and_alternates(findings)
        self.assertEqual(findings, [], 'a canonical or an hreflang pair is wrong')


if __name__ == '__main__':
    unittest.main(verbosity=2)
