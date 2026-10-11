package dwg

// headerSentinel introduces the header-variables section in every DWG
// version. Sentinels exist so a damaged file can be resynchronised by
// scanning for them; here it doubles as the cheapest possible proof that
// the container decoded correctly, since the odds of arriving at these
// exact 16 bytes by accident are nil.
var headerSentinel = [16]byte{
	0xCF, 0x7B, 0x1F, 0x23, 0xFD, 0xDE, 0x38, 0xA9,
	0x5F, 0x7C, 0x68, 0xB8, 0x4E, 0x6D, 0x33, 0x5F,
}
