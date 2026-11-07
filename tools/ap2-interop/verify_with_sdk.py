"""Verifies Vouch's AP2 chains (fixtures.json) with the official AP2 Python SDK.

Run: uv run python verify_with_sdk.py   (after: node make_fixtures.ts, from the repo root)
Exits non-zero if the SDK rejects a chain or reports a constraint violation.
"""
import json
import pathlib
import sys

from ap2.sdk.checkout_mandate_chain import CheckoutMandateChain
from ap2.sdk.mandate import MandateClient
from ap2.sdk.payment_mandate_chain import PaymentMandateChain
from jwcrypto.jwk import JWK

fx = json.loads((pathlib.Path(__file__).parent / 'fixtures.json').read_text())
user_pub = JWK(**fx['user_public_jwk'])
client = MandateClient()
failed = False

payloads = client.verify(token=fx['checkout_chain'], key_or_provider=lambda _t: user_pub, expected_aud='store-a', expected_nonce='nonce-m')
violations = CheckoutMandateChain.parse(payloads).verify(expected_checkout_hash=fx['checkout_hash'], checkout_jwt=fx['checkout_jwt'])
print('checkout chain: signatures OK;', 'violations:', violations or 'none')
failed |= bool(violations)

payloads = client.verify(token=fx['payment_chain'], key_or_provider=lambda _t: user_pub, expected_aud='paypal', expected_nonce='nonce-p')
violations = PaymentMandateChain.parse(payloads).verify(expected_transaction_id=fx['checkout_hash'], expected_open_checkout_hash=fx['open_checkout_reference'])
print('payment chain: signatures OK;', 'violations:', violations or 'none')
failed |= bool(violations)

sys.exit(1 if failed else 0)
