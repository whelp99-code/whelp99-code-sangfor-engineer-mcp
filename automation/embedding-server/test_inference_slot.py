import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Event

from inference_slot import InferenceBusy, InferenceSlot


class InferenceSlotTest(unittest.TestCase):
    def test_concurrent_request_is_refused_while_first_request_keeps_ownership(self):
        slot = InferenceSlot()
        entered, release = Event(), Event()

        def first():
            with slot.reserve():
                entered.set()
                if not release.wait(5):
                    raise TimeoutError('Test did not release the first request')

        def second():
            with slot.reserve():
                self.fail('Concurrent inference was admitted')

        with ThreadPoolExecutor(max_workers=2) as pool:
            running = pool.submit(first)
            try:
                self.assertTrue(entered.wait(1))
                self.assertTrue(slot.busy)
                refused = pool.submit(second)
                with self.assertRaises(InferenceBusy):
                    refused.result(timeout=1)
                self.assertTrue(slot.busy)
            finally:
                release.set()
                running.result(timeout=1)
        self.assertFalse(slot.busy)
        with slot.reserve():
            self.assertTrue(slot.busy)

    def test_inference_failure_releases_ownership(self):
        slot = InferenceSlot()
        with self.assertRaisesRegex(ValueError, 'model failure'):
            with slot.reserve():
                raise ValueError('model failure')
        self.assertFalse(slot.busy)
        with slot.reserve():
            self.assertTrue(slot.busy)


if __name__ == '__main__':
    unittest.main()
