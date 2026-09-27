#!/usr/bin/env bash
# sweep.sh [ticks]: corpus sweep + probes, prints the non-matching lines and counts
: "${A2M_SCRATCH:?set A2M_SCRATCH}"
cd $A2M_SCRATCH
TICKS=${1:-3000} A2M_STATE=1 LIST=$A2M_SCRATCH/all.txt bash tier1.sh > sweep.txt 2>&1
N=$(( ${1:-3000} + 1 ))
echo "corpus: $(grep -c " $N of $N" sweep.txt) / $(wc -l < sweep.txt)"
grep -v " $N of $N" sweep.txt
bash runprobes.sh > probes.txt 2>&1
echo "probes: $(grep -c '^ok' probes.txt) ok, $(grep -c '^FAIL' probes.txt) fail"
grep '^FAIL' probes.txt
