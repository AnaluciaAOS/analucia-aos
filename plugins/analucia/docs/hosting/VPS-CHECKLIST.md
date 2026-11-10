# Own server: checklist

For an owner who rents a server (AMD-0006 §4). Each item is done by the owner or someone the owner trusts.

- [ ] A non-root user for the app and for logins; root login over SSH turned off.
- [ ] A firewall that only opens the ports the app needs (for example SSH, 80 and 443).
- [ ] Security updates installed automatically, or on a fixed day each week.
- [ ] A backup off the server, and a restore that was tested at least once.
- [ ] Monitoring that tells the owner when the app is down or the disk is full.
- [ ] Keys, passwords and tokens kept outside the repository (for example in the provider's secret store or an environment file that is never committed).

What the tool does not do: this list is text. Analucia never connects to, configures or changes any server.
