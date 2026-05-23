# Skill: tide-glance
# Description: One-shot tide + sunset glance for a coastal location. Run when planning beach time.
# Status: Approved
# Vars: STATION=8516945, UNITS=english
# Output: text

fetch_tide:
    @ curl -s "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&application=skillscript&datum=MLLW&station=$(STATION)&time_zone=lst_ldt&units=$(UNITS)&interval=hilo&format=json&date=today" -> RAW (fallback: "{}")

summarize: fetch_tide
    ~ prompt="Read this NOAA tide JSON and produce two short lines: (1) the next high tide time + height, (2) the next low tide time + height. Today only. JSON: $(RAW)" model=qwen maxTokens=200 -> SUMMARY

emit: summarize
    ! Tide window for station $(STATION):
    ! $(SUMMARY|trim)

default: emit