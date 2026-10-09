// Apply only the reviewed single guard to the hash-pinned original module.
package main

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"os"
)

const reviewedPatch = "3607dfa9731f02c2cadcb91a57a74603f141ff9a9727d5155a98b49c77e29885"

const original = "6cf3e036a8ac399d981060253720d5fbb0cd026d1fb1808540cd6dfc9771aa4c"

func main() {
	if len(os.Args) != 3 {
		panic("exact original source and reviewed patch required")
	}
	source, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	patch, err := os.ReadFile(os.Args[2])
	if err != nil {
		panic(err)
	}
	old := []byte("if len(src[rp:]) < msgSize {")
	replacement := []byte("if msgSize < 0 || len(src[rp:]) < msgSize {")
	if fmt.Sprintf("%x", sha256.Sum256(patch)) != reviewedPatch || fmt.Sprintf("%x", sha256.Sum256(source)) != original || bytes.Count(source, old) != 1 || !bytes.Contains(patch, []byte("-\t\t\tif len(src[rp:]) < msgSize {")) || !bytes.Contains(patch, []byte("+\t\t\tif msgSize < 0 || len(src[rp:]) < msgSize {")) {
		panic("original source or patch drift")
	}
	fixed := bytes.Replace(source, old, replacement, 1)
	if err := os.WriteFile(os.Args[1], fixed, 0644); err != nil {
		panic(err)
	}
	fmt.Printf("original=%s patched=%x patch=%x\n", original, sha256.Sum256(fixed), sha256.Sum256(patch))
}
