import unittest
from selection import require_selected_target, validate_pair


class SelectionTests(unittest.TestCase):
    def test_supported_upgrade_channels(self):
        self.assertEqual(validate_pair('1.2.1', '1.3.0'), 'stable')
        self.assertEqual(validate_pair('1.4.0-beta.2', '1.4.0-beta.3'), 'beta')
        self.assertEqual(validate_pair('1.4.0-beta.9', '1.4.0'), 'stable')
        self.assertEqual(validate_pair('1.9.0', '1.11.0'), 'stable')

    def test_refuse_unsupported_and_invalid_pairs(self):
        for source, target in [('1.2.0', '1.3.0'), ('1.2.1-beta.9', '1.3.0'),
                               ('1.4.0', '1.4.0-beta.9'), ('1.4.0', '1.4.0'),
                               ('1.3.0', '1.4.0-beta.10'), ('1.3.0', '01.4.0'),
                               ('1.3.0', '../unsafe'), ('1.3.0', '')]:
            with self.subTest(source=source, target=target), self.assertRaises(AssertionError):
                validate_pair(source, target)

    def test_only_exact_selection_label_is_accepted(self):
        label = 'Release notes · v1.4.0-beta.2 → v1.4.0-beta.3'
        self.assertEqual(require_selected_target([{'name': label}], '1.4.0-beta.2', '1.4.0-beta.3'), label)
        for observed in [[], [{'name': '1.4.0-beta.3'}],
                         [{'name': label.replace('beta.3', 'beta.4')}],
                         [{'name': 'Changelog mentions 1.4.0-beta.3'}],
                         [{'name': label}, {'name': label}]]:
            with self.subTest(observed=observed), self.assertRaises(AssertionError):
                require_selected_target(observed, '1.4.0-beta.2', '1.4.0-beta.3')


if __name__ == '__main__':
    unittest.main()
