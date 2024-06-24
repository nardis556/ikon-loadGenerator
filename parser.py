def reformat_account_lines(input_file, output_file):
    with open(input_file, 'r') as file:
        lines = file.readlines()

    with open(output_file, 'w') as file:
        for i, line in enumerate(lines, start=1):
            new_account_number = f"ACCOUNT{str(i).zfill(4)}"
            new_line = line.replace(line.split('=')[0], new_account_number)
            file.write(new_line)

reformat_account_lines('.env.ACCOUNTS', 'env.ACCOUNTS.OUTPUT')
